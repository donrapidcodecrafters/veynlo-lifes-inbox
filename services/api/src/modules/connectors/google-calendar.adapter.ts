import { Inject, Injectable } from "@nestjs/common";
import { google, type calendar_v3 } from "googleapis";
import { eq } from "drizzle-orm";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { ConnectorNotConfiguredError } from "./connector-errors";

const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"];

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
export class GoogleCalendarAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly ingestion: IngestionService,
    private readonly queue: QueueProducerService,
  ) {}

  private oauthClient(redirectUri: string) {
    const env = loadEnv();
    return new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  }

  isConfigured(): boolean {
    return isConnectorConfigured("google");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_calendar");
    const client = this.oauthClient(params.redirectUri);
    return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: CALENDAR_SCOPES, state: params.state });
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
    historyDepthDays: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_calendar");
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "google_calendar",
      feasibilityClass: "direct_api",
      scopes: CALENDAR_SCOPES,
      enabledCategories: ["appointments"],
      health: "initializing",
      historyDepthDays: params.historyDepthDays,
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
      await this.db
        .delete(schema.calendarEvents)
        .where(eq(schema.calendarEvents.providerEventId, event.id));
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
}

export { ConnectorNotConfiguredError };
