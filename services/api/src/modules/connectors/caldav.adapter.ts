import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DAVClient } from "tsdav";
import * as ical from "node-ical";
import { generateId } from "@veynlo/core";
import type { TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CredentialVault } from "../../common/credential-vault";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { IngestionService } from "../ingestion/ingestion.service";
import { assertHostnameIsPublic } from "../ingestion/safe-url-fetcher";
import { findDavProvider, davServerUrl } from "./dav-providers";
import type { ConnectorAdapter } from "./connector.interface";

/**
 * CalDAV — a real, server-side calendar connection for everything that is not Google or Microsoft.
 *
 * Closes two Appendix A rows that were both marked Launch priority and neither built: "CalDAV servers"
 * and "Apple Calendar". The Apple one matters most. `apps/mobile` already has a "This phone's calendar"
 * card, but that is EventKit — a manual, one-device import that only sees what that phone holds and only
 * when somebody taps it. iCloud also speaks plain CalDAV with an app-specific password, which syncs by
 * itself, from the server, for every device the account has. Those are different features and this app
 * should have both.
 *
 * Nothing here re-implements calendar handling. Objects come back as iCalendar text, are parsed with the
 * same `node-ical` the ICS feed connector uses, and are filed through the same
 * `IngestionService.ingestFeedCalendarEvent` — so CalDAV events get the same dedup, the same temporal
 * handling, and the same search indexing as an ICS subscription, with no second code path to drift.
 *
 * The server URL is typed in by the user for custom and Nextcloud entries, so — exactly as with IMAP — it
 * is resolved and refused against private and reserved ranges before a request is made, and TLS is
 * required. The credential is a password rather than a revocable token, so it lives in the encrypted
 * vault and never appears in a log or an error message.
 */

/** How far back and forward to ask for. A calendar server will happily return a decade if not bounded. */
const SYNC_WINDOW_PAST_DAYS = 90;
const SYNC_WINDOW_FUTURE_DAYS = 400;
/** One sync's ceiling, across all calendars on the account. */
const MAX_EVENTS_PER_SYNC = 500;

interface DavCredentials {
  serverUrl: string;
  username: string;
  password: string;
  providerKey: string;
}

export interface DavConnectDto {
  providerKey: string;
  username: string;
  password: string;
  /** Only read for providers whose URL the user supplies (custom, Nextcloud). */
  serverUrl?: string;
  requestedHistoryDepthDays?: number;
}

@Injectable()
export class CalDavAdapter implements ConnectorAdapter {
  private readonly logger = new Logger(CalDavAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
  ) {}

  /** No deployment credential of its own — there is no app to register with a CalDAV server. */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Work out which server to talk to, and refuse anything internal before a request exists.
   *
   * Shared with the CardDAV adapter, which passes "carddav" — the only real difference between them is
   * that Apple serves contacts from a different host than calendars.
   */
  static async resolveServer(dto: DavConnectDto, service: "caldav" | "carddav"): Promise<string> {
    const provider = findDavProvider(dto.providerKey);
    if (!provider) {
      throw new BadRequestException({ code: "UNKNOWN_DAV_PROVIDER", message: "That calendar or contacts provider isn't one we recognise." });
    }
    if (!provider.services.includes(service)) {
      throw new BadRequestException({
        code: "DAV_SERVICE_UNSUPPORTED",
        message: `${provider.label} doesn't offer that over this protocol.`,
      });
    }

    const url = davServerUrl(provider, service, dto.serverUrl);
    if (!url) {
      throw new BadRequestException({ code: "DAV_URL_REQUIRED", message: "Enter your server's address." });
    }

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException({ code: "DAV_URL_INVALID", message: "That doesn't look like a server address." });
    }
    // A calendar password must not cross a network in the clear, same rule as IMAP.
    if (parsed.protocol !== "https:") {
      throw new BadRequestException({ code: "DAV_TLS_REQUIRED", message: "The server address must start with https://." });
    }
    try {
      await assertHostnameIsPublic(parsed.hostname);
    } catch {
      throw new BadRequestException({ code: "URL_UNREACHABLE", message: "Couldn't reach that server. Check the address and try again." });
    }

    return url;
  }

  private client(creds: { serverUrl: string; username: string; password: string }): DAVClient {
    return new DAVClient({
      serverUrl: creds.serverUrl,
      credentials: { username: creds.username, password: creds.password },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }

  /**
   * Verify the credential by logging in and discovering at least one calendar, then store it.
   *
   * Discovery is part of the check on purpose: a login that succeeds but exposes no calendar is a
   * connection that would sit in the user's list looking healthy and producing nothing — the false
   * "all caught up" state the spec forbids.
   */
  async connect(params: { dto: DavConnectDto; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    await this.entitlements.assertConnectorQuota(params.ownerUserId, "calendar");
    const serverUrl = await CalDavAdapter.resolveServer(params.dto, "caldav");

    const username = params.dto.username.trim();
    if (!username || !params.dto.password) {
      throw new BadRequestException({ code: "DAV_CREDENTIALS_REQUIRED", message: "Enter both your username and password." });
    }

    const client = this.client({ serverUrl, username, password: params.dto.password });
    try {
      await client.login();
      const calendars = await client.fetchCalendars();
      if (!calendars || calendars.length === 0) {
        throw new BadRequestException({
          code: "DAV_NO_CALENDARS",
          message: "Signed in, but that account has no calendars we can read.",
        });
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const provider = findDavProvider(params.dto.providerKey);
      // Never echo the server's raw error — it can carry the attempted username.
      this.logger.warn(`CalDAV connect failed for provider ${params.dto.providerKey}: ${(err as Error)?.name ?? "error"}`);
      throw new BadRequestException({
        code: "DAV_CONNECT_FAILED",
        message: provider?.credentialHint ?? "Couldn't sign in to that server. Check the address, username and password.",
      });
    }

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId, params.dto.requestedHistoryDepthDays);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "caldav",
      feasibilityClass: "open_standard",
      scopes: ["calendar.read"],
      enabledCategories: ["appointments"],
      health: "initializing",
      historyDepthDays,
    });

    const credentials: DavCredentials & Record<string, unknown> = {
      serverUrl,
      username,
      password: params.dto.password,
      providerKey: params.dto.providerKey,
    };
    const credentialRef = await this.vault.store(connectionId, credentials, null);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId);
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId);
  }

  private async sync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const creds = (await this.vault.read(connection.credentialRef)) as DavCredentials | null;
    if (!creds) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);

    const client = this.client(creds);
    let itemCount = 0;

    try {
      await client.login();
      const calendars = await client.fetchCalendars();

      const now = Date.now();
      const timeRange = {
        start: new Date(now - SYNC_WINDOW_PAST_DAYS * 86_400_000).toISOString(),
        end: new Date(now + SYNC_WINDOW_FUTURE_DAYS * 86_400_000).toISOString(),
      };

      for (const calendar of calendars) {
        if (itemCount >= MAX_EVENTS_PER_SYNC) break;
        // A CalDAV account routinely carries read-only subscriptions (holidays, birthdays) alongside real
        // calendars. They are still events the user sees, so they are synced — but a calendar that reports
        // no VEVENT support at all is skipped rather than queried pointlessly.
        const components = Array.isArray(calendar.components) ? calendar.components : [];
        if (components.length > 0 && !components.includes("VEVENT")) continue;

        let objects;
        try {
          objects = await client.fetchCalendarObjects({ calendar, timeRange });
        } catch (err) {
          // One unreadable calendar must not cost the rest of the account its sync.
          this.logger.warn(`Skipping a calendar on connection ${connectionId}: ${String((err as Error)?.message ?? err)}`);
          continue;
        }

        for (const object of objects ?? []) {
          if (itemCount >= MAX_EVENTS_PER_SYNC) break;
          if (!object.data) continue;

          let parsed: ical.CalendarResponse;
          try {
            parsed = ical.parseICS(object.data) as ical.CalendarResponse;
          } catch (err) {
            this.logger.warn(`Unparseable calendar object on connection ${connectionId}: ${String((err as Error)?.message ?? err)}`);
            continue;
          }

          for (const component of Object.values(parsed)) {
            if (!component || component.type !== "VEVENT" || !component.start) continue;
            const isAllDay = component.datetype === "date";
            const start: TemporalValue = isAllDay
              ? { precision: "date", instantUtc: null, date: component.start.toISOString().slice(0, 10), timezone: null, sourceText: null }
              : { precision: "instant", instantUtc: component.start.toISOString(), date: null, timezone: component.start.tz ?? null, sourceText: null };
            const end: TemporalValue | null = component.end
              ? isAllDay
                ? { precision: "date", instantUtc: null, date: component.end.toISOString().slice(0, 10), timezone: null, sourceText: null }
                : { precision: "instant", instantUtc: component.end.toISOString(), date: null, timezone: component.end.tz ?? null, sourceText: null }
              : null;

            const filed = await this.ingestion.ingestFeedCalendarEvent({
              provider: "caldav",
              ownerUserId: connection.ownerUserId,
              householdId: connection.householdId,
              connectionId,
              uid: component.uid,
              title: typeof component.summary === "string" ? component.summary : "Untitled event",
              start,
              end,
              isAllDay,
              location: typeof component.location === "string" ? component.location : null,
            });
            if (filed) itemCount += 1;
          }
        }
      }

      await this.db
        .update(schema.connections)
        .set({ health: "healthy", healthDetail: null, lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount })
        .where(eq(schema.connections.id, connectionId));
    } catch (err) {
      const authFailed = /401|403|unauthorized|forbidden/i.test(String((err as Error)?.message ?? ""));
      await this.db
        .update(schema.connections)
        .set({
          health: authFailed ? "reauth_required" : "degraded",
          healthDetail: authFailed
            ? "Your server rejected the saved password. App passwords are often revoked when you change your account password — generate a new one and reconnect."
            : "Couldn't reach your calendar server on the last sync.",
        })
        .where(eq(schema.connections.id, connectionId));
      throw err;
    }

    return { itemCount };
  }
}
