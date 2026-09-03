import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";
import { oauthTokenRequestError } from "./connection-health.util";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const CALENDAR_SCOPES = ["offline_access", "Calendars.Read"];
// CAL-001 "write-back capability... requested only when user enables write-back" — Graph's `Calendars.Read`
// grants no POST/PATCH on `/me/events`; `Calendars.ReadWrite` is required and, unlike Google, fully
// supersedes the readonly scope rather than needing both requested together.
const CALENDAR_WRITE_SCOPES = ["offline_access", "Calendars.ReadWrite"];
const EVENT_SELECT = "id,subject,start,end,isAllDay,location";
const FUTURE_WINDOW_DAYS = 730; // 2 years forward — a calendar sync's whole point is upcoming events, unlike email backfill which only looks backward

/** Same shape as the Google adapter's identical interface — see its doc comment. */
export interface WriteBackEventInput {
  title: string;
  location: string | null;
  isAllDay: boolean;
  startInstantUtc: string | null;
  startDate: string | null;
  endInstantUtc: string | null;
  endDate: string | null;
}

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

/**
 * Direct-API connector for Microsoft/Outlook Calendar via Microsoft Graph — a separate connection from
 * Outlook mail (own `provider: "microsoft_calendar"` row, same `MICROSOFT_OAUTH_CLIENT_ID/SECRET`).
 * Structurally like the ICS/Google Calendar connectors, not OutlookAdapter: a Graph calendar event already
 * IS a calendar event, so there's no domain classification/AI extraction step — see
 * `IngestionService.ingestFeedCalendarEvent`, shared by all three feed-style connectors. Uses Graph's
 * `calendarView/delta` (bounded to a date range, unlike plain message delta) for incremental sync.
 */
@Injectable()
export class MicrosoftCalendarAdapter implements OAuthConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("microsoft");
  }

  authorizationUrl(params: { redirectUri: string; state: string; writeBack?: boolean }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_calendar");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", (params.writeBack ? CALENDAR_WRITE_SCOPES : CALENDAR_SCOPES).join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
    /** CAL-001 write-back scope upgrade — see GoogleCalendarAdapter.handleCallback's identical param. */
    reauthConnectionId?: string;
    grantedWriteBack?: boolean;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_calendar");
    const requestedScopes = params.grantedWriteBack ? CALENDAR_WRITE_SCOPES : CALENDAR_SCOPES;
    const tokens = await this.exchangeCode(params.code, params.redirectUri, requestedScopes);

    if (params.reauthConnectionId) {
      const [existing] = await this.db
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.id, params.reauthConnectionId), eq(schema.connections.ownerUserId, params.ownerUserId), eq(schema.connections.provider, "microsoft_calendar")))
        .limit(1);
      if (!existing) throw new Error("Reconnect target not found or not owned by this user.");
      if (existing.credentialRef) {
        await this.vault.rotate(existing.credentialRef, { access_token: tokens.accessToken, refresh_token: tokens.refreshToken }, tokens.expiresAt);
      }
      await this.db
        .update(schema.connections)
        .set({ scopes: requestedScopes, writeBackEnabled: Boolean(params.grantedWriteBack), health: "healthy", updatedAt: new Date() })
        .where(eq(schema.connections.id, existing.id));
      return { connectionId: existing.id };
    }

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "microsoft_calendar",
      feasibilityClass: "direct_api",
      scopes: requestedScopes,
      enabledCategories: ["appointments"],
      health: "initializing",
      historyDepthDays,
      writeBackEnabled: Boolean(params.grantedWriteBack),
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
      // Scoped by ownerUserId, not just providerEventId — see google-calendar.adapter.ts's identical fix
      // for the full trace: a shared/invited event can carry the same provider event id in more than one
      // Veynlo user's calendar, and this delete used to remove every matching row regardless of owner.
      await this.db
        .delete(schema.calendarEvents)
        .where(and(eq(schema.calendarEvents.providerEventId, event.id), eq(schema.calendarEvents.ownerUserId, connection.ownerUserId)));
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
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: deltaLink })
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
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: latestDeltaLink,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async exchangeCode(code: string, redirectUri: string, scopes: string[] = CALENDAR_SCOPES): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: scopes.join(" "),
    });
    return this.requestToken(body);
  }

  /**
   * `scopes` must be the CONNECTION's own already-granted scope list, not always the base `CALENDAR_SCOPES`
   * constant — found while wiring CAL-001 write-back: refreshing with a hardcoded readonly scope here would
   * have silently downgraded a write-back-enabled connection's access token back to readonly on its very
   * next refresh, even though the user had already consented to `Calendars.ReadWrite`.
   */
  private async refreshAccessToken(refreshToken: string, scopes: string[] = CALENDAR_SCOPES): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: scopes.join(" "),
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw oauthTokenRequestError("Microsoft", response.status, await response.text());
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  /**
   * Same transparent-refresh-on-401 shape as OutlookAdapter.graphGet, plus `Prefer: outlook.timezone="UTC"`
   * — Microsoft's documented way to make calendar responses' `start`/`end` dateTime values come back
   * already in UTC (they're naive local time otherwise) — see `toTemporal` above for why this matters.
   */
  private async graphGet<T>(connection: { credentialRef: string | null; scopes?: string[] }, url: string): Promise<T> {
    return this.graphRequest<T>(connection, url, "GET");
  }

  /**
   * Generic transparent-refresh-on-401 Graph request, shared by `graphGet` and CAL-001's write-back
   * `createEvent`/`updateEvent`/`deleteEvent` below. Refreshes using `connection.scopes` (the connection's
   * own actually-granted scopes), not a hardcoded constant — see `refreshAccessToken`'s doc comment for why
   * that matters specifically for a write-back-enabled connection.
   */
  private async graphRequest<T>(connection: { credentialRef: string | null; scopes?: string[] }, url: string, method: "GET" | "POST" | "PATCH" | "DELETE", body?: unknown): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as MicrosoftCredentials;
    const buildHeaders = (token: string) => ({
      authorization: `Bearer ${token}`,
      prefer: 'outlook.timezone="UTC"',
      ...(body ? { "content-type": "application/json" } : {}),
    });
    const requestInit = { method, headers: buildHeaders(access_token), body: body ? JSON.stringify(body) : undefined };

    let response = await fetch(url, requestInit);
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token, connection.scopes?.length ? connection.scopes : undefined);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
      response = await fetch(url, { ...requestInit, headers: buildHeaders(refreshed.accessToken) });
    }
    if (!response.ok) {
      const err = new Error(`Microsoft Graph request failed: ${response.status} ${await response.text()}`) as Error & { status: number };
      err.status = response.status;
      throw err;
    }
    // A successful PATCH to /me/events/{id} returns 200 with a body in practice, but Graph's contract
    // allows a bodiless 204 for some update endpoints — guard against `.json()` throwing on an empty body.
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private toEventRequestBody(event: WriteBackEventInput): Record<string, unknown> {
    return {
      subject: event.title,
      location: event.location ? { displayName: event.location } : undefined,
      isAllDay: event.isAllDay,
      // Graph expects a naive local dateTime paired with an explicit timeZone, not a "Z"-suffixed UTC
      // instant — mirrors `toTemporal`'s inverse conversion above (this adapter always sends/receives in
      // UTC via `Prefer: outlook.timezone="UTC"`, so a stored ISO instant's "Z" suffix is stripped here).
      start: event.isAllDay
        ? { dateTime: `${event.startDate}T00:00:00`, timeZone: "UTC" }
        : { dateTime: (event.startInstantUtc ?? "").replace(/Z$/, ""), timeZone: "UTC" },
      end: event.isAllDay
        ? { dateTime: `${event.endDate ?? event.startDate}T00:00:00`, timeZone: "UTC" }
        : { dateTime: (event.endInstantUtc ?? event.startInstantUtc ?? "").replace(/Z$/, ""), timeZone: "UTC" },
    };
  }

  /** CAL-001 write-back — see GoogleCalendarAdapter.createEvent's identical doc comment; same
   * caller-verifies-writeBackEnabled-first contract. */
  async createEvent(connectionId: string, event: WriteBackEventInput): Promise<{ providerEventId: string }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const created = await this.graphRequest<{ id: string }>(connection, `${GRAPH_BASE}/me/events`, "POST", this.toEventRequestBody(event));
    if (!created?.id) throw new Error("Microsoft Graph didn't return an event id for the created event.");
    return { providerEventId: created.id };
  }

  async updateEvent(connectionId: string, providerEventId: string, event: WriteBackEventInput): Promise<void> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    await this.graphRequest(connection, `${GRAPH_BASE}/me/events/${providerEventId}`, "PATCH", this.toEventRequestBody(event));
  }

  /**
   * AUTO-006/CAL-001 write-back's missing half — deletes a previously pushed event from the user's
   * Microsoft/Outlook calendar via Graph's `DELETE /me/events/{id}`. Same caller-verifies-first contract as
   * `createEvent`/`updateEvent` above. A 404 means the event is already gone on Microsoft's side (deleted
   * directly in Outlook/Calendar, or a duplicate delete) — treated as success, matching
   * `GoogleCalendarAdapter.deleteEvent`'s identical 404/410 handling, since "this event no longer exists on
   * the provider" is exactly the end state being asked for either way.
   */
  async deleteEvent(connectionId: string, providerEventId: string): Promise<void> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    try {
      await this.graphRequest(connection, `${GRAPH_BASE}/me/events/${providerEventId}`, "DELETE");
    } catch (err) {
      if ((err as { status?: number }).status === 404) return;
      throw err;
    }
  }
}
