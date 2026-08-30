import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { ConnectorNotConfiguredError, classifyPermissionHealth, parseGrantedScopes } from "./connector-errors";
import { ConnectorsService } from "./connectors.service";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// CAL-001 "write-back capability" — was read-only. Existing connections keep working for reads; writing
// back requires reconnecting once to grant the new scope, same as GoogleCalendarAdapter's identical change.
const CALENDAR_SCOPES = ["offline_access", "Calendars.ReadWrite"];
const EVENT_SELECT = "id,subject,start,end,isAllDay,location";
const FUTURE_WINDOW_DAYS = 730; // 2 years forward — a calendar sync's whole point is upcoming events, unlike email backfill which only looks backward

interface MicrosoftCredentials {
  access_token: string;
  refresh_token: string;
}

interface GraphEventDateTime {
  dateTime?: string;
  timeZone?: string;
}

interface GraphCalendarEvent {
  id?: string;
  subject?: string;
  start?: GraphEventDateTime;
  end?: GraphEventDateTime;
  isAllDay?: boolean;
  location?: { displayName?: string };
  "@removed"?: { reason?: string };
}

function toTemporal(dt: GraphEventDateTime | undefined, isAllDay: boolean): TemporalValue {
  if (isAllDay && dt?.dateTime) {
    return { precision: "date", instantUtc: null, date: dt.dateTime.slice(0, 10), timezone: null, sourceText: null };
  }
  // Graph's dateTime is a naive local timestamp with NO offset — converting it to a real UTC instant would
  // need the IANA zone in `timeZone` applied by hand. Every request below instead sends
  // `Prefer: outlook.timezone="UTC"`, Microsoft's documented way to make the API itself return dateTime
  // values already in UTC — so appending "Z" here is correct precisely because of that header, not despite it.
  return { precision: "instant", instantUtc: dt?.dateTime ? `${dt.dateTime}Z` : null, date: null, timezone: "UTC", sourceText: null };
}

/** Reverse of toTemporal, for pushEvent. Graph wants a naive local dateTime + a separate IANA timeZone for
 * a timed event (we always write it as UTC, matching the `Prefer: outlook.timezone="UTC"` read side), or
 * just a plain date for an all-day event. */
function fromTemporal(value: TemporalValue, isAllDay: boolean): GraphEventDateTime {
  if (isAllDay) return { dateTime: value.date ?? new Date().toISOString().slice(0, 10), timeZone: "UTC" };
  const instant = value.instantUtc ?? new Date().toISOString();
  return { dateTime: instant.replace("Z", ""), timeZone: "UTC" };
}

/**
 * Direct-API connector for Microsoft/Outlook Calendar via Microsoft Graph — a separate connection from
 * Outlook mail (own `provider: "microsoft_calendar"` row, same `MICROSOFT_OAUTH_CLIENT_ID/SECRET`).
 * Structurally like the ICS/Google Calendar connectors, not OutlookAdapter: a Graph calendar event already
 * IS a calendar event, so there's no domain classification/AI extraction step — see
 * `IngestionService.ingestFeedCalendarEvent`, shared by all three feed-style connectors. Uses Graph's
 * `calendarView/delta` (bounded to a date range, unlike plain message delta) for incremental sync.
 */
@Injectable()
export class MicrosoftCalendarAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly ingestion: IngestionService,
    private readonly queue: QueueProducerService,
    private readonly connectors: ConnectorsService,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("microsoft");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_calendar");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", CALENDAR_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
    historyDepthDays: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_calendar");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const { connectionId } = await this.connectors.upsertConnectionForConnect({
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "microsoft_calendar",
      feasibilityClass: "direct_api",
      // What Microsoft actually granted, not what was requested — see classifyPermissionHealth's comment.
      // Microsoft's token response omits `scope` entirely on some tenant configurations; treated as
      // "unknown, assume healthy" (parseGrantedScopes(undefined) === []) rather than a false positive.
      scopes: parseGrantedScopes(tokens.scope),
      enabledCategories: ["appointments"],
      historyDepthDays: params.historyDepthDays,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.accessToken, refresh_token: tokens.refreshToken },
      tokens.expiresAt,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  private async ingestEvent(connection: typeof schema.connections.$inferSelect, connectionId: string, event: GraphCalendarEvent): Promise<boolean> {
    if (!event.id) return false;
    if (event["@removed"]) {
      await this.db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.providerEventId, event.id));
      return false; // a removal isn't a new item to count/file — nothing to review
    }
    const isAllDay = Boolean(event.isAllDay);
    return this.ingestion.ingestFeedCalendarEvent({
      provider: "microsoft_calendar",
      ownerUserId: connection.ownerUserId,
      householdId: connection.householdId,
      connectionId,
      uid: event.id,
      title: event.subject ?? "Untitled event",
      start: toTemporal(event.start, isAllDay),
      end: event.end ? toTemporal(event.end, isAllDay) : null,
      isAllDay,
      location: event.location?.displayName ?? null,
    });
  }

  /** CAL-001 "write-back capability" — same bounded scope as GoogleCalendarAdapter.pushEvent: one-way
   * push on explicit user action, create-or-update by `providerEventId`, not continuous two-way sync. */
  async pushEvent(
    connectionId: string,
    event: {
      providerEventId: string | null;
      title: string;
      start: TemporalValue;
      end: TemporalValue | null;
      isAllDay: boolean;
      location: string | null;
      reminderMinutesBefore: number | null;
    },
  ): Promise<{ providerEventId: string }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const body = {
      subject: event.title,
      isAllDay: event.isAllDay,
      start: fromTemporal(event.start, event.isAllDay),
      end: fromTemporal(event.end ?? event.start, event.isAllDay),
      location: event.location ? { displayName: event.location } : undefined,
      isReminderOn: event.reminderMinutesBefore != null,
      reminderMinutesBeforeStart: event.reminderMinutesBefore ?? undefined,
    };
    const result = event.providerEventId
      ? await this.graphWrite<{ id: string }>(connection, `${GRAPH_BASE}/me/events/${event.providerEventId}`, "PATCH", body)
      : await this.graphWrite<{ id: string }>(connection, `${GRAPH_BASE}/me/events`, "POST", body);
    return { providerEventId: result.id };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const startDateTime = new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000).toISOString();
    const endDateTime = new Date(Date.now() + FUTURE_WINDOW_DAYS * 86_400_000).toISOString();
    let url =
      `${GRAPH_BASE}/me/calendarView/delta?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}` +
      `&$select=${EVENT_SELECT}`;

    let itemCount = 0;
    let deltaLink: string | null = null;
    do {
      const page = await this.graphGet<{ value: GraphCalendarEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
      for (const event of page.value) {
        if (await this.ingestEvent(connection, connectionId, event)) itemCount += 1;
      }
      if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    } while (url);

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, CALENDAR_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: itemCount,
        cursor: deltaLink,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /**
   * Real incremental sync driven by the deltaLink `initialSync` established. A stale/expired deltaLink
   * (Graph returns 410 Gone) falls back to a fresh full resync, same recovery as OutlookAdapter's mail
   * delta query and GoogleCalendarAdapter's syncToken.
   */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    if (!connection.cursor) return this.initialSync(connectionId);

    let itemCount = 0;
    let url = connection.cursor;
    let latestDeltaLink = connection.cursor;

    try {
      do {
        const page = await this.graphGet<{ value: GraphCalendarEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
        for (const event of page.value) {
          if (await this.ingestEvent(connection, connectionId, event)) itemCount += 1;
        }
        if (page["@odata.deltaLink"]) latestDeltaLink = page["@odata.deltaLink"];
        url = page["@odata.nextLink"] ?? "";
      } while (url);
    } catch (err) {
      if ((err as { status?: number }).status === 410) return this.initialSync(connectionId);
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, CALENDAR_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: latestDeltaLink,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: CALENDAR_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: CALENDAR_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw new Error(`Microsoft token request failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: json.scope,
    };
  }

  /**
   * Same transparent-refresh-on-401 shape as OutlookAdapter.graphGet, plus `Prefer: outlook.timezone="UTC"`
   * — Microsoft's documented way to make calendar responses' `start`/`end` dateTime values come back
   * already in UTC (they're naive local time otherwise) — see `toTemporal` above for why this matters.
   */
  private async graphGet<T>(connection: { credentialRef: string | null }, url: string): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as MicrosoftCredentials;
    const headers = { authorization: `Bearer ${access_token}`, prefer: 'outlook.timezone="UTC"' };

    let response = await fetch(url, { headers });
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
      response = await fetch(url, { headers: { authorization: `Bearer ${refreshed.accessToken}`, prefer: 'outlook.timezone="UTC"' } });
    }
    if (!response.ok) {
      const err = new Error(`Microsoft Graph request failed: ${response.status} ${await response.text()}`) as Error & { status: number; retryAfterHeader?: string };
      err.status = response.status;
      err.retryAfterHeader = response.headers.get("retry-after") ?? undefined;
      throw err;
    }
    return response.json() as Promise<T>;
  }

  /** Same transparent-refresh-on-401 shape as graphGet, for POST/PATCH writes (event create/update). */
  private async graphWrite<T>(connection: { credentialRef: string | null }, url: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as MicrosoftCredentials;
    const headers = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };

    let response = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
      response = await fetch(url, { method, headers: { authorization: `Bearer ${refreshed.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    if (!response.ok) {
      const err = new Error(`Microsoft Graph write failed: ${response.status} ${await response.text()}`) as Error & { status: number; retryAfterHeader?: string };
      err.status = response.status;
      err.retryAfterHeader = response.headers.get("retry-after") ?? undefined;
      throw err;
    }
    return response.json() as Promise<T>;
  }
}

