import { Inject, Injectable } from "@nestjs/common";
import { google, type calendar_v3 } from "googleapis";
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

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];
// CAL-001 "write-back capability... requested only when user enables write-back" — Google has no separate
// "write" scope; `calendar` (full read/write) is the only scope that grants `events.insert`/`.patch`, so
// enabling write-back means re-requesting this broader scope in place of the readonly one, not adding to
// it. `include_granted_scopes: true` on the auth URL (see `authorizationUrl` below) is Google's documented
// incremental-authorization flag — it keeps this upgrade a single extra consent screen rather than forcing
// the user to lose (and re-grant) every other scope they'd already granted.
const CALENDAR_WRITE_SCOPES = ["https://www.googleapis.com/auth/calendar"];

/** Converts a calendar_events row (already decrypted by drizzle's encryptedText custom type) into the
 * subset of fields both `createEvent` and `updateEvent` need — shared with the Microsoft adapter's
 * identically-shaped private helper, but kept adapter-local since each maps to a different wire format. */
export interface WriteBackEventInput {
  title: string;
  location: string | null;
  isAllDay: boolean;
  /** ISO instant — required unless isAllDay. */
  startInstantUtc: string | null;
  /** date-only "YYYY-MM-DD" — required when isAllDay. */
  startDate: string | null;
  endInstantUtc: string | null;
  endDate: string | null;
}

function toTemporal(dt: calendar_v3.Schema$EventDateTime | undefined): { value: TemporalValue; isAllDay: boolean } {
  if (dt?.date) {
    return { value: { precision: "date", instantUtc: null, date: dt.date, timezone: null, sourceText: null }, isAllDay: true };
  }
  return {
    value: { precision: "instant", instantUtc: dt?.dateTime ?? null, date: null, timezone: dt?.timeZone ?? null, sourceText: null },
    isAllDay: false,
  };
}

/**
 * Direct-API connector for Google Calendar (§Connections — distinct from Gmail: a calendar event already
 * IS a calendar event, so there's no domain classification/AI extraction step, same shape as the ICS feed
 * connector — see `IngestionService.ingestFeedCalendarEvent`, shared by both. Reuses the same
 * GOOGLE_OAUTH_CLIENT_ID/SECRET as Gmail (one Google Cloud OAuth app can request both scopes), just a
 * separate `provider: "google_calendar"` connection so a user can connect one without the other.
 */
@Injectable()
export class GoogleCalendarAdapter implements OAuthConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  private oauthClient(redirectUri: string) {
    const env = loadEnv();
    return new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  }

  isConfigured(): boolean {
    return isConnectorConfigured("google");
  }

  authorizationUrl(params: { redirectUri: string; state: string; writeBack?: boolean }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_calendar");
    const client = this.oauthClient(params.redirectUri);
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: params.writeBack ? CALENDAR_WRITE_SCOPES : CALENDAR_SCOPES,
      state: params.state,
    });
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
    /** CAL-001 write-back scope upgrade — set when this callback is a reconnect of an EXISTING connection
     * (initiated by ConnectorsController's write-back reauthorize flow) rather than a brand-new connect.
     * Rotates that connection's credentials/scopes in place instead of inserting a second connections row
     * for the same provider account. */
    reauthConnectionId?: string;
    grantedWriteBack?: boolean;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_calendar");
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);
    const grantedScopes = tokens.scope ? tokens.scope.split(" ") : params.grantedWriteBack ? CALENDAR_WRITE_SCOPES : CALENDAR_SCOPES;

    if (params.reauthConnectionId) {
      const [existing] = await this.db
        .select()
        .from(schema.connections)
        .where(and(eq(schema.connections.id, params.reauthConnectionId), eq(schema.connections.ownerUserId, params.ownerUserId), eq(schema.connections.provider, "google_calendar")))
        .limit(1);
      if (!existing) throw new Error("Reconnect target not found or not owned by this user.");
      if (existing.credentialRef) {
        await this.vault.rotate(
          existing.credentialRef,
          { access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope },
          tokens.expiry_date ? new Date(tokens.expiry_date) : null,
        );
      }
      await this.db
        .update(schema.connections)
        .set({ scopes: grantedScopes, writeBackEnabled: Boolean(params.grantedWriteBack), health: "healthy", updatedAt: new Date() })
        .where(eq(schema.connections.id, existing.id));
      return { connectionId: existing.id };
    }

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "google_calendar",
      feasibilityClass: "direct_api",
      scopes: grantedScopes,
      enabledCategories: ["appointments"],
      health: "initializing",
      historyDepthDays,
      writeBackEnabled: Boolean(params.grantedWriteBack),
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope },
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  private async client(connectionId: string) {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    const oauth = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/google-calendar/callback`);
    oauth.setCredentials(credentials);
    return { connection, calendar: google.calendar({ version: "v3", auth: oauth }) };
  }

  private async ingestEvent(connection: typeof schema.connections.$inferSelect, connectionId: string, event: calendar_v3.Schema$Event): Promise<boolean> {
    if (!event.id) return false;
    if (event.status === "cancelled") {
      // Scoped by ownerUserId, not just providerEventId — a shared/invited event (two attendees, e.g.
      // two household members, both syncing the same Google Calendar event) commonly carries the SAME
      // provider event id in both of their calendars. Without the owner scope, cancelling it from either
      // side deleted BOTH users' calendar_events rows via this one unscoped DELETE — cross-tenant data
      // loss found live during the backend audit (every insert/update path already scopes by
      // ownerUserId+providerEventId via ingestFeedCalendarEvent; only this delete-on-cancel path didn't).
      await this.db
        .delete(schema.calendarEvents)
        .where(and(eq(schema.calendarEvents.providerEventId, event.id), eq(schema.calendarEvents.ownerUserId, connection.ownerUserId)));
      return false; // a removal isn't a new item to count/file — nothing to review
    }
    const { value: start, isAllDay } = toTemporal(event.start);
    const { value: end } = toTemporal(event.end);
    return this.ingestion.ingestFeedCalendarEvent({
      provider: "google_calendar",
      ownerUserId: connection.ownerUserId,
      householdId: connection.householdId,
      connectionId,
      uid: event.id,
      title: event.summary ?? "Untitled event",
      start,
      end: event.end ? end : null,
      isAllDay,
      location: event.location ?? null,
    });
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, calendar } = await this.client(connectionId);
    const timeMin = new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000).toISOString();

    let itemCount = 0;
    let pageToken: string | undefined;
    let nextSyncToken: string | null | undefined;
    do {
      const list = await calendar.events.list({
        calendarId: "primary",
        timeMin,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
      });
      for (const event of list.data.items ?? []) {
        if (await this.ingestEvent(connection, connectionId, event)) itemCount += 1;
      }
      pageToken = list.data.nextPageToken ?? undefined;
      if (list.data.nextSyncToken) nextSyncToken = list.data.nextSyncToken;
    } while (pageToken);

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: nextSyncToken ?? null })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /**
   * Real incremental sync keyed off `events.list`'s `syncToken` (the Calendar API's equivalent of Gmail's
   * historyId). A syncToken expires (Google returns 410 Gone) if too much time passes between syncs — the
   * documented recovery is a fresh full sync, not treating this as a fatal connector failure, same as
   * Gmail's historyId-404 handling.
   */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, calendar } = await this.client(connectionId);
    if (!connection.cursor) return this.initialSync(connectionId);

    let itemCount = 0;
    let pageToken: string | undefined;
    let nextSyncToken: string | null | undefined;
    try {
      do {
        const list = await calendar.events.list({
          calendarId: "primary",
          syncToken: connection.cursor,
          maxResults: 250,
          pageToken,
        });
        for (const event of list.data.items ?? []) {
          if (await this.ingestEvent(connection, connectionId, event)) itemCount += 1;
        }
        pageToken = list.data.nextPageToken ?? undefined;
        if (list.data.nextSyncToken) nextSyncToken = list.data.nextSyncToken;
      } while (pageToken);
    } catch (err) {
      const status = (err as { code?: number; response?: { status?: number } })?.code ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 410) return this.initialSync(connectionId);
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: nextSyncToken ?? connection.cursor,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private toEventRequestBody(event: WriteBackEventInput): calendar_v3.Schema$Event {
    return {
      summary: event.title,
      location: event.location ?? undefined,
      start: event.isAllDay ? { date: event.startDate ?? undefined } : { dateTime: event.startInstantUtc ?? undefined },
      end: event.isAllDay
        ? { date: event.endDate ?? event.startDate ?? undefined }
        : { dateTime: event.endInstantUtc ?? event.startInstantUtc ?? undefined },
    };
  }

  /**
   * CAL-001 write-back — pushes a Veynlo-created/edited event to the user's primary Google Calendar. Uses
   * the same `client(connectionId)` OAuth/credential-refresh machinery `initialSync`/`incrementalSync`
   * already rely on (the `googleapis` client library transparently refreshes an expired access token using
   * the stored refresh_token, so there's no separate refresh path to write here, unlike Microsoft's adapter
   * below). Callers (CalendarWriteBackService) are responsible for verifying `writeBackEnabled` first — this
   * method just does the actual provider call and assumes that's already been checked.
   */
  async createEvent(connectionId: string, event: WriteBackEventInput): Promise<{ providerEventId: string }> {
    const { calendar } = await this.client(connectionId);
    const res = await calendar.events.insert({ calendarId: "primary", requestBody: this.toEventRequestBody(event) });
    if (!res.data.id) throw new Error("Google Calendar didn't return an event id for the created event.");
    return { providerEventId: res.data.id };
  }

  async updateEvent(connectionId: string, providerEventId: string, event: WriteBackEventInput): Promise<void> {
    const { calendar } = await this.client(connectionId);
    await calendar.events.patch({ calendarId: "primary", eventId: providerEventId, requestBody: this.toEventRequestBody(event) });
  }

  /**
   * AUTO-006/CAL-001 write-back's missing half — deletes a previously pushed event from the user's primary
   * Google Calendar. Same OAuth/credential-refresh machinery as `createEvent`/`updateEvent` above; same
   * caller-verifies-first contract (`CalendarWriteBackService.deleteEvent` only calls this when the local
   * row actually carries a `providerEventId` for this connection). A 404/410 means the event is already
   * gone on Google's side (deleted directly in Google Calendar, or a duplicate delete) — treated as success
   * rather than an error, since "this event no longer exists on the provider" is exactly the end state
   * being asked for either way.
   */
  async deleteEvent(connectionId: string, providerEventId: string): Promise<void> {
    const { calendar } = await this.client(connectionId);
    try {
      await calendar.events.delete({ calendarId: "primary", eventId: providerEventId });
    } catch (err) {
      const status = (err as { code?: number; response?: { status?: number } })?.code ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 404 || status === 410) return;
      throw err;
    }
  }
}
