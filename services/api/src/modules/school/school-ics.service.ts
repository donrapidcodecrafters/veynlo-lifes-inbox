import { Inject, Injectable } from "@nestjs/common";
import * as ical from "node-ical";
import { eq } from "drizzle-orm";
import type { TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { IngestionService } from "../ingestion/ingestion.service";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";

// Same dedicated cap as IcsAdapter's MAX_ICS_BYTES — a school/team feed has no reason to be larger than a
// personal calendar feed.
const MAX_SCHOOL_ICS_BYTES = 15_000_000;

function textValue(v: string | { val: string } | undefined | null): string | null {
  if (v == null) return null;
  return typeof v === "string" ? v : v.val;
}

/**
 * §25 SCH-002 "School/calendar feed" — the school-domain sibling of `connectors/ics.adapter.ts`,
 * deliberately NOT folded into the general connectors/OAuth machinery: a `school_sources` row isn't a
 * `connections` row (no OAuth, no credential vault entry worth the indirection — the ICS URL itself is
 * the entire credential, and it's kept as an `encryptedText` column directly on the row for that reason).
 * Reuses the exact same SSRF-safe fetch path (`SafeUrlFetcher.fetchTrustedBytes`) `IcsAdapter` uses, for
 * the identical reason: this URL is polled on a recurring schedule (see worker-main.ts's
 * schoolSourceScanWorker), so an unguarded fetch would be a standing SSRF primitive, not a one-off risk.
 */
@Injectable()
export class SchoolIcsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(SafeUrlFetcher) private readonly safeUrlFetcher: SafeUrlFetcher,
  ) {}

  private async fetchCalendar(url: string): Promise<ical.CalendarResponse> {
    const { body } = await this.safeUrlFetcher.fetchTrustedBytes(url, { maxBytes: MAX_SCHOOL_ICS_BYTES });
    return ical.parseICS(body) as ical.CalendarResponse;
  }

  /** Probes the feed synchronously before SchoolService.createSchoolSource's row is created — a bad URL
   * should be immediate, actionable feedback on the subscribe request, mirroring IcsAdapter.connect. */
  async probe(url: string): Promise<void> {
    await this.fetchCalendar(url);
  }

  async sync(schoolSourceId: string): Promise<{ itemCount: number }> {
    const [source] = await this.db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, schoolSourceId)).limit(1);
    if (!source || source.kind !== "ics" || !source.icsUrl || source.disconnectedAt) return { itemCount: 0 };

    let calendar: ical.CalendarResponse;
    try {
      calendar = await this.fetchCalendar(source.icsUrl);
    } catch (err) {
      await this.db
        .update(schema.schoolSources)
        .set({ health: "degraded", healthDetail: String((err as Error)?.message ?? err) })
        .where(eq(schema.schoolSources.id, schoolSourceId));
      throw err;
    }

    let itemCount = 0;
    for (const component of Object.values(calendar)) {
      if (!component || component.type !== "VEVENT") continue;
      const title = textValue(component.summary) ?? "Untitled event";
      const isAllDay = component.datetype === "date";
      const start: TemporalValue = isAllDay
        ? { precision: "date", instantUtc: null, date: component.start.toISOString().slice(0, 10), timezone: null, sourceText: null }
        : { precision: "instant", instantUtc: component.start.toISOString(), date: null, timezone: component.start.tz ?? null, sourceText: null };
      // node-ical's own VEVENT typings don't declare `status` even though a real feed can carry
      // `STATUS:CANCELLED` — same untyped-but-present shape node-ical exposes for a few other fields.
      const canceled = (component as unknown as { status?: string }).status === "CANCELLED";

      // SCH-005 "arrival time, equipment/volunteer notes if sourced" — found live: this only ever read
      // summary/location off the VEVENT, dropping DESCRIPTION entirely, even though a real team/school ICS
      // feed routinely puts arrival/equipment/volunteer notes there. See ingestFeedSchoolEvent's own doc
      // comment for why this goes into `description` as-is rather than an attempted arrivalNote parse.
      const filed = await this.ingestion.ingestFeedSchoolEvent({
        ownerUserId: source.createdByUserId,
        householdId: source.householdId,
        schoolSourceId,
        schoolId: source.schoolId,
        uid: component.uid,
        title,
        start,
        isAllDay,
        location: textValue(component.location),
        description: textValue(component.description),
        canceled,
      });
      if (filed) itemCount += 1;
    }

    await this.db
      .update(schema.schoolSources)
      .set({ health: "healthy", healthDetail: null, lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount })
      .where(eq(schema.schoolSources.id, schoolSourceId));
    return { itemCount };
  }
}
