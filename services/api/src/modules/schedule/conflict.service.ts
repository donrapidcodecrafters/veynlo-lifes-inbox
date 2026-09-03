import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { generateId, expandOccurrences, type RecurrenceRule, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { type EffectiveRange, effectiveRange, rangesOverlap } from "./time-range.util";
import { householdAdultBusyIntervals, isAdultFreeDuring } from "./adult-availability";

// CAL-003 recurring-event conflict expansion — bounded window policy: any recurring event (the one being
// created/checked AND every candidate it's compared against) is expanded up to this many days forward from
// "now", never unboundedly. 90 days is a deliberate, separate choice from `ScheduleService.previewOccurrences`'s
// UI preview window (365 days, but capped by *occurrence count* — 5 — not by days; that number exists only
// to hint "this repeats" in a list row, not to exhaustively scan for collisions). A pairwise conflict scan
// needs its own days-based bound so it can never become an unbounded N×M scan against every future
// occurrence of every recurring event a household has ever created; 90 days (one quarter) is a realistic
// look-ahead for "will this new event double-book a recurring series" while staying cheap at this app's
// scale (one household's own visible events, not a multi-tenant scheduling system).
const CONFLICT_EXPANSION_WINDOW_DAYS = 90;

function isoDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface OccurrenceRange {
  /** Null for the event's own stored anchor occurrence — preserves the exact pre-existing conflict identity
   * (pairKey + null) for every event that isn't recurring, or whose recurrence rule can't be expanded here
   * (see `occurrenceRanges`'s own guard). Set to the concrete YYYY-MM-DD date for every additional expanded
   * future occurrence. */
  occurrenceDate: string | null;
  range: EffectiveRange;
}

/**
 * CAL-003 "Conflict detection". Spec asks for four checks:
 *
 *  1. True overlap (built) — two events for the same owner, or the same household (respecting the existing
 *     visibility rules `ScheduleService.ownerOrDelegatedHousehold` already enforces for reads), whose
 *     effective time ranges intersect. Now expands recurring events (both the checked event AND every
 *     candidate) over the bounded window above via `occurrenceRanges`, rather than only ever comparing each
 *     row's own single stored `start`/`end` — a weekly-recurring event's 3rd future occurrence used to be
 *     completely invisible to this check (found during a follow-up audit; see this file's sibling doc for
 *     the exact repro). Each distinct colliding occurrence-date gets its own `schedule_conflicts` row (see
 *     the schema column's own doc comment) rather than collapsing multiple real collisions into one.
 *  2. Double-booked shared assets (built, narrowed) — the spec's own example ("a car needing to be in two
 *     places at once"): `vehicleProfiles` is the only genuinely bookable shared-resource concept this app
 *     has (confirmed via grep — no other "shared resource booking" concept exists anywhere). A calendar
 *     event tags "using this vehicle" via `calendarEvents.relatedEntityIds` (populated by
 *     `ScheduleService.createEvent`/`setEventVehicle` — previously declared in the schema and written
 *     nowhere). `vehicleConflicts` below flags the SAME vehicle referenced by two overlapping events,
 *     reusing the exact same recurring-expansion/dedup machinery as true overlap. Deliberately NOT
 *     generalized to arbitrary "shared resources" beyond vehicles — this app has no other bookable-asset
 *     concept to hang that on, and inventing one would be a new feature, not closing this scoped gap.
 *  3. Impossible travel time / dependent transportation conflicts (NOT built) — both need real geolocation
 *     (geocode two `location` strings, compute a travel-time estimate). No geocoding/maps API integration
 *     exists anywhere in this codebase (confirmed via grep for "geocod"/"maps"/"distance" across
 *     services/api — zero hits) and none of Phase 2's already-configured providers (Google/Microsoft OAuth,
 *     Plaid, Dropbox) offer it. Needs a paid API dependency and a product decision on which one, same as the
 *     other credential-gated items in this file's sibling doc.
 *  4. Email-vs-calendar date disagreement (built, narrowed) — NOT the fuzzy "is this the same appointment"
 *     guess this doc comment used to defer on; `recordDateDisagreement` below is called by
 *     `IngestionService` only after ITS OWN tight, unambiguous title match (reusing the exact same
 *     precision-first matching discipline CAL-004's reschedule reconciliation and CAL-001's cross-source
 *     linking already use — same owner, exact normalized title, "more than one candidate -> no match")
 *     finds an existing calendar event from a DIFFERENT source whose date disagrees with what the email
 *     states. Never auto-updates (CAL-004 already does that for a same-source match) and never silently
 *     drops the discrepancy (the old cross-source behavior) — files a resolvable conflict + inbox item
 *     instead, with the user picking which date is right (`InboxService.resolveDateDisagreement`).
 */
@Injectable()
export class ConflictService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
  ) {}

  /**
   * Expands one event into every occurrence range worth checking for a conflict: its own stored anchor
   * (always — `occurrenceDate: null`, exactly the pre-existing single-range behavior), plus, when it
   * recurs, every FUTURE occurrence (today through `CONFLICT_EXPANSION_WINDOW_DAYS` days out) the rule
   * produces. Mileage-based rules (`mileage`/`mileage_or_calendar`) have no calendar-date series at all
   * (`expandOccurrences` itself throws for them — see recurrence.ts) and "days_before" resolves against a
   * DIFFERENT row's date via a DB lookup (`ScheduleService.resolveDaysBeforeAnchorDate`) this service has no
   * access to — both fall back to the anchor-only range, same as a non-recurring event; only the extra
   * future-occurrence expansion is skipped, never the anchor check itself.
   */
  private occurrenceRanges(event: { start: TemporalValue; end: TemporalValue | null; isAllDay: boolean; recurrenceRule: RecurrenceRule | null }): OccurrenceRange[] {
    const base = effectiveRange(event);
    if (!base) return [];
    const anchor: OccurrenceRange = { occurrenceDate: null, range: base };
    const rule = event.recurrenceRule;
    if (!rule || rule.kind === "mileage" || rule.kind === "mileage_or_calendar" || rule.kind === "days_before") return [anchor];

    const anchorDate = event.isAllDay
      ? event.start.precision === "date"
        ? event.start.date
        : null
      : event.start.precision === "instant"
        ? (event.start.instantUtc?.slice(0, 10) ?? null)
        : null;
    if (!anchorDate) return [anchor];

    const todayIso = isoDateOnly(new Date());
    const windowEndIso = isoDateOnly(new Date(Date.now() + CONFLICT_EXPANSION_WINDOW_DAYS * 86_400_000));
    const durationMs = base.endMs - base.startMs;
    // How far into its own day the anchor occurrence starts (0 for all-day) — reapplied to every expanded
    // occurrence's midnight-UTC date below so a recurring event's own time-of-day is preserved without
    // needing to reconstruct a full TemporalValue per occurrence (recurrence.ts's own "date math in UTC"
    // discipline — expandOccurrences only ever produces YYYY-MM-DD strings, deliberately).
    const timeOfDayOffsetMs = base.startMs - Date.parse(`${anchorDate}T00:00:00.000Z`);

    let dates: string[];
    try {
      dates = expandOccurrences(rule, anchorDate, { from: anchorDate, to: windowEndIso });
    } catch {
      return [anchor]; // defensive — every kind that throws is already excluded above; never let a corrupt rule crash conflict detection
    }

    const extra: OccurrenceRange[] = [];
    for (const date of dates) {
      if (date === anchorDate) continue; // the anchor occurrence is already covered above
      if (date < todayIso) continue; // only current/future occurrences matter for a live conflict check
      const startMs = Date.parse(`${date}T00:00:00.000Z`) + timeOfDayOffsetMs;
      extra.push({ occurrenceDate: date, range: { startMs, endMs: startMs + durationMs } });
    }
    return [anchor, ...extra];
  }

  /**
   * Shared dedup+insert for every symmetric conflict kind (`time_overlap`, `vehicle_double_booked`):
   * records one `schedule_conflicts` row per (unordered event pair, occurrence date), reusing an existing
   * unresolved row for the exact same pair+date rather than creating a duplicate (established dedup
   * discipline, just keyed one level finer than before — see the schema column's own doc comment on why a
   * recurring series colliding on three different dates needs three rows, not one).
   */
  private async recordConflicts(
    kind: string,
    eventId: string,
    householdId: string | null,
    pairs: Array<{ otherId: string; occurrenceDate: string | null }>,
  ): Promise<Array<typeof schema.scheduleConflicts.$inferSelect>> {
    if (pairs.length === 0) return [];
    const unresolvedOfKind = await this.db
      .select()
      .from(schema.scheduleConflicts)
      .where(and(eq(schema.scheduleConflicts.kind, kind), isNull(schema.scheduleConflicts.resolvedAt)));

    const seenThisRun = new Set<string>();
    const involving: Array<typeof schema.scheduleConflicts.$inferSelect> = [];
    for (const { otherId, occurrenceDate } of pairs) {
      const pairKey = [eventId, otherId].sort();
      const dedupKey = `${pairKey.join(",")}|${occurrenceDate ?? ""}`;
      if (seenThisRun.has(dedupKey)) continue; // two different occurrence-range combos collapsing to the same (pair, date) within this one call
      seenThisRun.add(dedupKey);

      const already = unresolvedOfKind.find(
        (c) =>
          c.involvedEventIds.length === 2 &&
          [...c.involvedEventIds].sort().every((id, i) => id === pairKey[i]) &&
          (c.occurrenceDate ?? null) === (occurrenceDate ?? null),
      );
      if (already) {
        involving.push(already);
        continue;
      }
      const row: typeof schema.scheduleConflicts.$inferInsert = {
        id: generateId("scheduleConflict"),
        householdId,
        kind,
        involvedEventIds: pairKey,
        occurrenceDate: occurrenceDate ?? null,
        detectedAt: new Date(),
        resolvedAt: null,
      };
      const [inserted] = await this.db.insert(schema.scheduleConflicts).values(row).returning();
      if (inserted) involving.push(inserted);
    }
    return involving;
  }

  /**
   * Runs the true-overlap check for one event against every other still-confirmed event visible to the
   * same owner (their own events, plus any non-private event in a household they belong to or are
   * delegated into — same visibility stance `ScheduleService` already applies to reads). Records a new
   * `schedule_conflicts` row for each newly-found overlapping pair, but only if an unresolved conflict
   * naming that exact pair doesn't already exist — precision-first dedup, same stance as
   * `findExistingDiscoveredCalendarEvent`/`findExistingBill` elsewhere in this codebase: re-detecting the
   * same collision on every subsequent save must not spam duplicate conflict rows.
   *
   * Returns every unresolved conflict now involving this event (newly created or pre-existing), so the
   * caller (event creation, or ingestion's discovered-event path) can surface it to the user immediately —
   * spec's "detected... whenever a new/edited event is saved."
   */
  async detectOverlaps(eventId: string, _ownerUserId: string): Promise<Array<typeof schema.scheduleConflicts.$inferSelect>> {
    const [event] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event || event.status === "canceled") return [];
    const eventOccurrences = this.occurrenceRanges(event);
    if (eventOccurrences.length === 0) return [];

    // Coarse DB-side window covers every occurrence range just computed (±1 day of buffer around the
    // earliest/latest of them, same buffer the pre-expansion version always used) — for a non-recurring
    // event this is exactly the old ±1-day-around-its-own-range window; for a recurring one it stretches out
    // to cover the full 90-day expansion. The precise overlap test happens in JS below regardless, since
    // encrypted `title`/`location` aren't comparable in SQL anyway.
    const allMs = eventOccurrences.flatMap((o) => [o.range.startMs, o.range.endMs]);
    const windowStart = new Date(Math.min(...allMs) - 86_400_000);
    const windowEnd = new Date(Math.max(...allMs) + 86_400_000);

    const visibility = event.householdId
      ? or(
          eq(schema.calendarEvents.ownerUserId, event.ownerUserId),
          and(eq(schema.calendarEvents.householdId, event.householdId), ne(schema.calendarEvents.visibility, "private")),
        )!
      : eq(schema.calendarEvents.ownerUserId, event.ownerUserId);

    const candidates = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          visibility,
          ne(schema.calendarEvents.id, event.id),
          ne(schema.calendarEvents.status, "canceled"),
          // A candidate is worth precisely checking if its OWN anchor falls in the checked event's window,
          // OR it has any recurrence rule at all — a recurring candidate's future occurrences can collide
          // with the checked event even when its own anchor is nowhere near this window (the exact bug this
          // pass fixes: a one-off event landing on an existing weekly series' 3rd future occurrence).
          or(and(gte(schema.calendarEvents.startSort, windowStart), lte(schema.calendarEvents.startSort, windowEnd)), isNotNull(schema.calendarEvents.recurrenceRule))!,
        ),
      );

    const conflictingPairs: Array<{ otherId: string; occurrenceDate: string | null }> = [];
    for (const candidate of candidates) {
      const candidateOccurrences = this.occurrenceRanges(candidate);
      for (const eo of eventOccurrences) {
        for (const co of candidateOccurrences) {
          if (rangesOverlap(eo.range, co.range)) {
            // Prefer the CHECKED event's own occurrence date when it has one — "this occurrence of the
            // event I'm creating/editing conflicts" is the more natural framing than the candidate's; falls
            // back to the candidate's when the checked event itself was only ever compared at its anchor
            // (e.g. a new one-off event colliding with a recurring candidate's future occurrence).
            conflictingPairs.push({ otherId: candidate.id, occurrenceDate: eo.occurrenceDate ?? co.occurrenceDate });
          }
        }
      }
    }
    return this.recordConflicts("time_overlap", event.id, event.householdId ?? null, conflictingPairs);
  }

  /**
   * CAL-003 "double-booked shared assets" (built, vehicle-only slice — see this class's own doc comment).
   * `event.relatedEntityIds[0]` is the single vehicle it's tagged with, by convention (a calendar event
   * references at most one vehicle — see ScheduleService.createEvent/setEventVehicle, the column's only
   * writers). Flags every OTHER still-confirmed event referencing that exact same vehicle whose effective
   * range overlaps, including each side's own recurring-occurrence expansion (same `occurrenceRanges`/
   * bounded-window/dedup machinery `detectOverlaps` uses, reused rather than reimplemented).
   */
  async vehicleConflicts(eventId: string): Promise<Array<typeof schema.scheduleConflicts.$inferSelect>> {
    const [event] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event || event.status === "canceled") return [];
    const vehicleId = event.relatedEntityIds[0];
    if (!vehicleId) return [];

    const eventOccurrences = this.occurrenceRanges(event);
    if (eventOccurrences.length === 0) return [];

    // Same household-or-own visibility stance detectOverlaps uses — a shared vehicle's other bookings are
    // only checked against events this owner can already see (their own, or a non-private event in a
    // household they belong to/are delegated into), never an unrelated household's private schedule.
    const visibility = event.householdId
      ? or(
          eq(schema.calendarEvents.ownerUserId, event.ownerUserId),
          and(eq(schema.calendarEvents.householdId, event.householdId), ne(schema.calendarEvents.visibility, "private")),
        )!
      : eq(schema.calendarEvents.ownerUserId, event.ownerUserId);

    // relatedEntityIds is a plain (unencrypted) jsonb array with no index and no existing containment-query
    // precedent in this codebase (it was "declared and read nowhere" until this pass) — a coarse SQL
    // prefilter plus an in-app containment check mirrors the same "coarse DB window, precise JS check" split
    // every other check in this file already uses, just for a different reason (there, encrypted columns;
    // here, an un-indexed jsonb array not worth a raw `@>` operator at this app's scale).
    const candidates = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(visibility, ne(schema.calendarEvents.id, event.id), ne(schema.calendarEvents.status, "canceled")));

    const conflictingPairs: Array<{ otherId: string; occurrenceDate: string | null }> = [];
    for (const candidate of candidates) {
      if (!candidate.relatedEntityIds.includes(vehicleId)) continue;
      const candidateOccurrences = this.occurrenceRanges(candidate);
      for (const eo of eventOccurrences) {
        for (const co of candidateOccurrences) {
          if (rangesOverlap(eo.range, co.range)) {
            conflictingPairs.push({ otherId: candidate.id, occurrenceDate: eo.occurrenceDate ?? co.occurrenceDate });
          }
        }
      }
    }
    return this.recordConflicts("vehicle_double_booked", event.id, event.householdId ?? null, conflictingPairs);
  }

  /**
   * CAL-003 "email-vs-calendar date disagreement" (built, narrowed slice — see this class's own doc
   * comment). `IngestionService` is the only caller: `emailEventId`/`existingCalendarEventId` are ALREADY
   * the two rows it tightly matched (same owner, exact normalized title, "more than one candidate -> no
   * match" — same discipline as `findExistingDiscoveredCalendarEvent`/`findCrossSourceCalendarEventMatch`)
   * whose dates disagree. Unlike `time_overlap`/`vehicle_double_booked`, this pair is directional (one side
   * is always "what the email says," the other "what the calendar currently shows") and never sorted —
   * `InboxService.resolveDateDisagreement` needs to know which is which to act on "use email date" vs. "keep
   * calendar date". No occurrence-date concept here (this isn't a recurrence-expansion case), and no
   * `preferOccurrenceDate` — always a single fixed pair per call.
   *
   * Returns `isNew: false` when an unresolved disagreement for this exact pair already exists (re-detected
   * on a later, e.g. reminder, email about the same appointment) — the caller uses that to avoid filing a
   * second inbox item for a discrepancy the user hasn't resolved yet.
   */
  async recordDateDisagreement(
    emailEventId: string,
    existingCalendarEventId: string,
    householdId: string | null,
  ): Promise<{ conflict: typeof schema.scheduleConflicts.$inferSelect; isNew: boolean } | null> {
    const kind = "email_calendar_date_disagreement";
    const already = await this.db
      .select()
      .from(schema.scheduleConflicts)
      .where(and(eq(schema.scheduleConflicts.kind, kind), isNull(schema.scheduleConflicts.resolvedAt)));
    const existingRow = already.find((c) => c.involvedEventIds.length === 2 && c.involvedEventIds[0] === emailEventId && c.involvedEventIds[1] === existingCalendarEventId);
    if (existingRow) return { conflict: existingRow, isNew: false };

    const row: typeof schema.scheduleConflicts.$inferInsert = {
      id: generateId("scheduleConflict"),
      householdId,
      kind,
      involvedEventIds: [emailEventId, existingCalendarEventId],
      occurrenceDate: null,
      detectedAt: new Date(),
      resolvedAt: null,
    };
    const [inserted] = await this.db.insert(schema.scheduleConflicts).values(row).returning();
    return inserted ? { conflict: inserted, isNew: true } : null;
  }

  /**
   * Every unresolved conflict naming at least one event this user owns, for the Life page's plain
   * dismiss-only conflict banner — including `vehicle_double_booked` conflicts between two DIFFERENT
   * household members' own events (each member sees the row via their own event id, without needing to see
   * the other member's private event itself).
   *
   * Deliberately EXCLUDES `email_calendar_date_disagreement`: unlike `time_overlap`/`vehicle_double_booked`,
   * that kind's correct resolution isn't a plain acknowledge/dismiss (the whole point is the user must pick
   * WHICH date is right) — it already gets its own real choice UI via the inbox item
   * `IngestionService.checkCalendarDateDisagreement` files (`InboxService.resolveDateDisagreement`).
   * Surfacing it a second time on this banner, where "Dismiss" would call the generic `resolveConflict` and
   * mark it settled WITHOUT ever applying either date, would silently defeat the "never silently drop the
   * discrepancy" reasoning this whole feature exists for — found live during this pass's own verification
   * (both events happened to share a title, rendering the confusing "X overlaps with X").
   * `school_transport` needs no equivalent exclusion here — its `involvedEventIds` reference `school_events`
   * rows, a different table entirely, so it can never match `ownedIdSet` (built from `calendar_events`) in
   * the first place; it already has its own separate `unresolvedSchoolTransportConflicts` reader below.
   */
  async unresolvedConflicts(userId: string): Promise<Array<typeof schema.scheduleConflicts.$inferSelect>> {
    const ownedEventIds = await this.db.select({ id: schema.calendarEvents.id }).from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId));
    const ownedIdSet = new Set(ownedEventIds.map((e) => e.id));
    const unresolved = await this.db
      .select()
      .from(schema.scheduleConflicts)
      .where(and(isNull(schema.scheduleConflicts.resolvedAt), ne(schema.scheduleConflicts.kind, "email_calendar_date_disagreement")));
    return unresolved.filter((c) => c.involvedEventIds.some((id) => ownedIdSet.has(id)));
  }

  /**
   * "Resolve conflict" user action (spec) — at minimum, dismiss/acknowledge it. Owner-of-either-event only
   * for a `calendar_events`-based conflict (`time_overlap`, `vehicle_double_booked`, and
   * `email_calendar_date_disagreement` — calendar_events are per-owner-private by default, and either
   * involved event's owner should be able to dismiss/act on the pair); any active household member for a
   * `school_transport` conflict (school_events are household-shared data, not per-owner private — see
   * school.ts's schema comment on the household-restricted default), since the two dependents involved may
   * both belong to caregivers who aren't the row's original discoverer.
   */
  async resolveConflict(conflictId: string, userId: string): Promise<void> {
    const [conflict] = await this.db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, conflictId)).limit(1);
    if (!conflict || conflict.involvedEventIds.length === 0) return;

    if (conflict.kind === "school_transport") {
      if (!conflict.householdId) return;
      const memberHouseholdIds = await this.households.activeHouseholdIds(userId);
      if (!memberHouseholdIds.includes(conflict.householdId)) return;
    } else {
      const involved = await this.db
        .select({ id: schema.calendarEvents.id, ownerUserId: schema.calendarEvents.ownerUserId })
        .from(schema.calendarEvents)
        .where(inArray(schema.calendarEvents.id, conflict.involvedEventIds));
      const isInvolvedOwner = involved.some((e) => e.ownerUserId === userId);
      if (!isInvolvedOwner) return;
    }
    await this.db.update(schema.scheduleConflicts).set({ resolvedAt: new Date() }).where(eq(schema.scheduleConflicts.id, conflictId));
  }

  /**
   * Family transport-conflict management (§25's school-relevant slice of CAL-003, and the specific case
   * this pass's brief calls out): flags when two DIFFERENT dependents each have a school/activity event
   * requiring drop-off/pickup (`school_events.requiresDropoff`/`requiresPickup`, set only for game/practice/
   * field_trip kinds — see IngestionService.extractSchool) within an overlapping — or, for a date-only-
   * precision discovered event with no extracted time, same-day — window in the same household.
   *
   * Now also checks whether an available adult driver actually exists, using
   * `householdAdultBusyIntervals` (adult-availability.ts) — every active adult household member's own busy
   * intervals across their own `calendar_events` (private ones included; see that function's own doc
   * comment for exactly why that's safe: only start/end ever come back, never title/location). For each
   * newly-detected pair:
   *   - If at least one adult is free during EACH event's own drop-off/pickup window, the conflict is
   *     marked `severity: "standard"`: two kids need rides, but someone is realistically available for each.
   *   - If NO adult is free for one or both windows, it's marked `severity: "elevated"` and
   *     `unavailableEventIds` names which of the two events (a subset — see the schema column's own doc
   *     comment) has literally nobody free, for the UI to call out specifically.
   *
   * Deliberately does NOT go further and require the free adult(s) to be two DIFFERENT people when the two
   * windows overlap in time (one person obviously can't drive both at once) — that finer distinction would
   * need real per-adult commitment tracking ("adult X is now assigned to event A") this app has no concept
   * of, and without it, flagging "only one shared adult is free for this simultaneous pair" as urgently as
   * "literally nobody is free" would overstate a real distinction: a single free adult, even shared, is a
   * meaningfully different (and less urgent) situation than a household where every adult is already
   * committed elsewhere. "At least one free adult per window" is therefore the line this heuristic actually
   * draws — see the same-adult-can-only-be-in-one-place caveat folded into the best-effort note below.
   *
   * Re-checked (and the stored row refreshed) every time this runs, not just computed once at first
   * detection — an adult's own calendar can change after the pair was first flagged, and re-running this
   * check whenever the school event is saved again should reflect the current picture.
   *
   * Still an inherent best-effort heuristic, not a scheduling guarantee — see
   * `householdAdultBusyIntervals`'s own doc comment: an adult "free" per their calendar might not actually
   * be available (no license, out of gas, at work with nothing on their calendar for it), and one who's
   * calendar-idle-but-actually-busy will still show as free. It can also under-flag the narrow case where
   * the exact same single adult is the only one free for two SIMULTANEOUS windows (they can't literally be
   * in both places), and it never claims otherwise. This surfaces a real, more urgent case earlier than
   * never checking at all; it can't promise a driver actually shows up.
   */
  async schoolTransportConflicts(schoolEventId: string, householdId: string | null): Promise<Array<typeof schema.scheduleConflicts.$inferSelect>> {
    if (!householdId) return [];
    const [event] = await this.db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.id, schoolEventId)).limit(1);
    if (!event || event.status === "canceled" || !event.dependentId || (!event.requiresDropoff && !event.requiresPickup)) return [];
    const range = effectiveRange({ start: event.start, end: null, isAllDay: event.isAllDay });
    if (!range) return [];

    const windowStart = new Date(range.startMs - 86_400_000);
    const windowEnd = new Date(range.endMs + 86_400_000);

    const candidates = await this.db
      .select()
      .from(schema.schoolEvents)
      .where(
        and(
          eq(schema.schoolEvents.householdId, householdId),
          ne(schema.schoolEvents.id, event.id),
          ne(schema.schoolEvents.status, "canceled"),
          isNotNull(schema.schoolEvents.dependentId),
          or(eq(schema.schoolEvents.requiresDropoff, true), eq(schema.schoolEvents.requiresPickup, true))!,
          gte(schema.schoolEvents.startSort, windowStart),
          lte(schema.schoolEvents.startSort, windowEnd),
        ),
      );

    const conflicting: Array<{ id: string; range: EffectiveRange }> = [];
    for (const candidate of candidates) {
      if (candidate.dependentId === event.dependentId) continue; // same child's own back-to-back schedule, not a transport conflict between two children
      const candidateRange = effectiveRange({ start: candidate.start, end: null, isAllDay: candidate.isAllDay });
      if (candidateRange && rangesOverlap(range, candidateRange)) conflicting.push({ id: candidate.id, range: candidateRange });
    }
    if (conflicting.length === 0) return [];

    // One busy-interval snapshot per household, covering every candidate pair's combined window, reused
    // across all of them below rather than re-querying per pair.
    const windowStartsMs = [range.startMs, ...conflicting.map((c) => c.range.startMs)];
    const windowEndsMs = [range.endMs, ...conflicting.map((c) => c.range.endMs)];
    const busyByAdult = await householdAdultBusyIntervals(this.db, this.households, householdId, Math.min(...windowStartsMs), Math.max(...windowEndsMs));

    const unresolved = await this.db
      .select()
      .from(schema.scheduleConflicts)
      .where(and(eq(schema.scheduleConflicts.kind, "school_transport"), isNull(schema.scheduleConflicts.resolvedAt)));

    const involving: Array<typeof schema.scheduleConflicts.$inferSelect> = [];
    for (const candidate of conflicting) {
      const pairKey = [event.id, candidate.id].sort();
      const { severity, unavailableEventIds } = this.resolveTransportAvailability(event.id, range, candidate.id, candidate.range, busyByAdult);

      const already = unresolved.find((c) => c.involvedEventIds.length === 2 && [...c.involvedEventIds].sort().every((id, i) => id === pairKey[i]));
      if (already) {
        const unchanged =
          already.severity === severity && [...already.unavailableEventIds].sort().join(",") === [...unavailableEventIds].sort().join(",");
        if (unchanged) {
          involving.push(already);
        } else {
          const [updated] = await this.db
            .update(schema.scheduleConflicts)
            .set({ severity, unavailableEventIds })
            .where(eq(schema.scheduleConflicts.id, already.id))
            .returning();
          involving.push(updated ?? already);
        }
        continue;
      }
      const row: typeof schema.scheduleConflicts.$inferInsert = {
        id: generateId("scheduleConflict"),
        householdId,
        kind: "school_transport",
        involvedEventIds: pairKey,
        severity,
        unavailableEventIds,
        detectedAt: new Date(),
        resolvedAt: null,
      };
      const [inserted] = await this.db.insert(schema.scheduleConflicts).values(row).returning();
      if (inserted) involving.push(inserted);
    }
    return involving;
  }

  /**
   * The actual "is this resolvable" matching for one transport-conflict pair — see
   * `schoolTransportConflicts`' own doc comment for the rule this implements. `busyByAdult` never carries
   * anything beyond busy intervals (see `householdAdultBusyIntervals`'s doc comment), so nothing this
   * method touches or returns can ever be event content — only which of the two event ids has no free
   * adult, which the caller (and the UI, via a household member's own already-authorized read of their own
   * school events) can already resolve into a title on its own.
   */
  private resolveTransportAvailability(
    eventId: string,
    eventRange: EffectiveRange,
    candidateId: string,
    candidateRange: EffectiveRange,
    busyByAdult: Map<string, { startMs: number; endMs: number }[]>,
  ): { severity: "standard" | "elevated"; unavailableEventIds: string[] } {
    const freeForEvent = new Set(
      [...busyByAdult.entries()].filter(([, busy]) => isAdultFreeDuring(busy, eventRange.startMs, eventRange.endMs)).map(([userId]) => userId),
    );
    const freeForCandidate = new Set(
      [...busyByAdult.entries()].filter(([, busy]) => isAdultFreeDuring(busy, candidateRange.startMs, candidateRange.endMs)).map(([userId]) => userId),
    );
    const noAdultForEvent = freeForEvent.size === 0;
    const noAdultForCandidate = freeForCandidate.size === 0;
    const unavailableEventIds: string[] = [];
    if (noAdultForEvent) unavailableEventIds.push(eventId);
    if (noAdultForCandidate) unavailableEventIds.push(candidateId);

    // "At least one free adult per window" — see schoolTransportConflicts' own doc comment for why this
    // deliberately doesn't also require the two free adults to be different people when the windows
    // overlap in time (that finer distinction needs real per-adult commitment tracking this app doesn't
    // have).
    const resolvable = !noAdultForEvent && !noAdultForCandidate;
    return { severity: resolvable ? "standard" : "elevated", unavailableEventIds };
  }

  /** Every unresolved school_transport conflict for a household — household-scoped, not owner-scoped like unresolvedConflicts, since school_events are household-shared data (see schoolTransportConflicts' own doc comment). */
  async unresolvedSchoolTransportConflicts(householdId: string): Promise<Array<typeof schema.scheduleConflicts.$inferSelect>> {
    return this.db
      .select()
      .from(schema.scheduleConflicts)
      .where(and(eq(schema.scheduleConflicts.householdId, householdId), eq(schema.scheduleConflicts.kind, "school_transport"), isNull(schema.scheduleConflicts.resolvedAt)));
  }
}
