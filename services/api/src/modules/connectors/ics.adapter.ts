import { Inject, Injectable } from "@nestjs/common";
import * as ical from "node-ical";
import { eq } from "drizzle-orm";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import type { IcsConnectDto } from "./dto";
import type { ConnectorAdapter } from "./connector.interface";

const MAX_ICS_BYTES = 15_000_000; // an ICS feed's own dedicated cap — larger than a captured web page's 5MB, since a busy shared household/work calendar's full feed can be a genuinely large text file

interface IcsCredentials {
  url: string;
  feedName?: string;
  basicAuthUsername?: string;
  basicAuthPassword?: string;
}

function textValue(v: string | { val: string } | undefined | null): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : v.val;
}

/**
 * A calendar-feed-by-URL subscription — structurally nothing like Gmail/Outlook (no OAuth, no per-message
 * extraction pipeline; a VEVENT already *is* a calendar event). No deployment-wide config to gate on, so
 * `isConfigured()` is always true — what varies is per-connection (the feed URL/credentials), not a
 * platform-wide API key. See `IngestionService.ingestFeedCalendarEvent` for the actual write path.
 */
@Injectable()
export class IcsAdapter implements ConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(SafeUrlFetcher) private readonly safeUrlFetcher: SafeUrlFetcher,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  private fetchHeaders(creds: Pick<IcsCredentials, "basicAuthUsername" | "basicAuthPassword">): Record<string, string> {
    if (!creds.basicAuthUsername) return {};
    const encoded = Buffer.from(`${creds.basicAuthUsername}:${creds.basicAuthPassword ?? ""}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }

  /**
   * Fetches and parses the feed via SafeUrlFetcher rather than node-ical's own `fromURL` — `fromURL` is a
   * bare `fetch()` with default (follow) redirects and no IP-range validation at all, i.e. an unguarded
   * SSRF primitive: a user could `connect` an ICS feed URL pointed at `http://169.254.169.254/...` (cloud
   * instance metadata) or an internal-network address, and since this connector is polled on every
   * recurring incremental-sync tick (see worker-main.ts's connectorScanWorker), that request would fire
   * from the server on a schedule forever, not just once. SafeUrlFetcher.fetchTrustedBytes resolves and
   * validates every hop's hostname (including redirect destinations) against private/reserved IP ranges
   * before requesting it — the same protection safe-url-fetcher.ts already applies to user-submitted "save
   * this page" URLs, just never previously applied to this connector. Parsing is then just handing the
   * already-safely-fetched text to node-ical's synchronous `parseICS`.
   */
  private async fetchCalendar(url: string, creds: Pick<IcsCredentials, "basicAuthUsername" | "basicAuthPassword">): Promise<ical.CalendarResponse> {
    const { body } = await this.safeUrlFetcher.fetchTrustedBytes(url, { headers: this.fetchHeaders(creds), maxBytes: MAX_ICS_BYTES });
    return ical.parseICS(body) as ical.CalendarResponse;
  }

  /**
   * Probes the feed synchronously before creating any DB row — a bad URL or auth failure should be
   * immediate, actionable feedback on the connect request, not a connection that silently sits
   * "degraded" until the next poll tick explains why.
   */
  async connect(params: { dto: IcsConnectDto; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    await this.fetchCalendar(params.dto.url, params.dto);

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "ics",
      feasibilityClass: "feed_subscription",
      scopes: [],
      enabledCategories: ["appointments"],
      health: "initializing",
    });
    const credentials: IcsCredentials & Record<string, unknown> = {
      url: params.dto.url,
      feedName: params.dto.feedName,
      basicAuthUsername: params.dto.basicAuthUsername,
      basicAuthPassword: params.dto.basicAuthPassword,
    };
    const credentialRef = await this.vault.store(connectionId, credentials, null);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId);
  }

  /** No protocol-level delta mechanism exists for a plain ICS feed — every "incremental" sync is really a
   * full refetch, deduped/updated by each VEVENT's own UID via IngestionService.ingestFeedCalendarEvent. */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId);
  }

  private async sync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const credentials = (await this.vault.read(connection.credentialRef)) as IcsCredentials | null;
    if (!credentials) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);

    const calendar = await this.fetchCalendar(credentials.url, credentials);

    let itemCount = 0;
    for (const component of Object.values(calendar)) {
      if (!component || component.type !== "VEVENT") continue;
      const title = textValue(component.summary) ?? "Untitled event";
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
        provider: "ics",
        ownerUserId: connection.ownerUserId,
        householdId: connection.householdId,
        connectionId,
        uid: component.uid,
        title,
        start,
        end,
        isAllDay,
        location: textValue(component.location),
      });
      if (filed) itemCount += 1;
    }

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }
}
