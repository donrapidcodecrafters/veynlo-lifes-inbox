import { z } from "zod";

/**
 * TASK-003 "Recurrence engine" — a discriminated-union recurrence rule, stored as jsonb on
 * `calendarEvents.recurrenceRule`/`tasks.recurrenceRule` (see packages/db/src/schema/schedule.ts), plus a
 * pure date-expansion function. Kept deliberately narrower than full RFC 5545 RRULE: this app's spec
 * bullet list ("maintenance intervals, nth weekday, business-day, 'X days before event,' mileage/usage
 * conditions, provider-derived cycles") is a product-language list, not an RRULE grammar request, so this
 * models exactly those cases rather than a general BYSETPOS/BYYEARDAY-style parser nobody asked for.
 *
 * All date math here is calendar-date arithmetic in UTC (Date.UTC), never wall-clock/local-timezone math —
 * consistent with `TemporalValue`'s "date" precision (packages/core/src/util/time.ts), which already
 * represents a floating calendar date with no attached instant. A recurring event's time-of-day (when its
 * TemporalValue has "instant" precision) is preserved separately by the caller (ScheduleService), which
 * re-applies the original time to each newly computed date — this module only ever produces YYYY-MM-DD
 * strings, deliberately, so it can't accidentally fabricate a instant precision the rule didn't establish.
 *
 * VEH-007/TASK-003 follow-up: mileage/usage-condition recurrence ("every 5,000 miles") is now modeled —
 * see the "mileage" rule kind below — now that `packages/db/src/schema/assets.ts` has real odometer
 * tracking (`odometerObservations`) to evaluate it against. It's deliberately NOT expanded by
 * `expandOccurrences` below: that function is pure calendar-date arithmetic with no DB access, and "next
 * due mileage" instead needs the vehicle's latest recorded odometer reading, which only the caller (see
 * `ScheduleService`'s mileage-status wiring) has access to. `nextMileageDue` below is the mileage-rule
 * equivalent of `expandOccurrences`+`nextOccurrenceAfter` combined — a pure function of
 * (rule, baseline mileage, current mileage), same "no DB access in this module" discipline as everything
 * else here.
 *
 * Still explicitly NOT modeled:
 *  - "Provider-derived cycles" — Google/Microsoft Calendar's own RRULE on a synced event. Neither
 *    `google-calendar.adapter.ts` nor `microsoft-calendar.adapter.ts` reads or stores the provider's
 *    recurrence payload today; wiring that in is a connector-adapter change, not a core-engine one.
 */

export const WeekendAdjustmentSchema = z.enum(["none", "nearest_weekday", "next_weekday", "previous_weekday"]);
export type WeekendAdjustment = z.infer<typeof WeekendAdjustmentSchema>;

const IntervalSchema = z.number().int().min(1).max(365);
/** 0 = Sunday ... 6 = Saturday, matching `Date#getUTCDay()`. */
const WeekdaySchema = z.number().int().min(0).max(6);

export const RecurrenceRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), interval: IntervalSchema, weekendAdjustment: WeekendAdjustmentSchema.optional() }),
  z.object({
    kind: z.literal("weekly"),
    interval: IntervalSchema,
    // Empty means "same weekday as the anchor date" — most callers never need to set this explicitly.
    daysOfWeek: z.array(WeekdaySchema).default([]),
    weekendAdjustment: WeekendAdjustmentSchema.optional(),
  }),
  z.object({
    kind: z.literal("monthly"),
    interval: IntervalSchema,
    // null means "same day-of-month as the anchor date". Clamped to the target month's actual length
    // (e.g. dayOfMonth 31 on a 30-day month lands on the 30th) rather than rolling into the next month.
    dayOfMonth: z.number().int().min(1).max(31).nullable().default(null),
    weekendAdjustment: WeekendAdjustmentSchema.optional(),
  }),
  z.object({ kind: z.literal("yearly"), interval: IntervalSchema, weekendAdjustment: WeekendAdjustmentSchema.optional() }),
  z.object({
    kind: z.literal("nth_weekday"),
    // "2nd Tuesday of the month", every `interval` months.
    interval: IntervalSchema,
    weekday: WeekdaySchema,
    nth: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(-1)]), // -1 = last
    weekendAdjustment: WeekendAdjustmentSchema.optional(),
  }),
  // "Business-day" cadence — every `interval`-th weekday (Mon-Fri), skipping weekends by construction.
  // No weekendAdjustment field: a business-day rule can never land on a weekend in the first place.
  z.object({ kind: z.literal("business_day"), interval: IntervalSchema }),
  z.object({
    kind: z.literal("days_before"),
    days: z.number().int().min(0).max(365),
    // The *other* row this rule is anchored to (e.g. "3 days before this vehicle's registration renewal
    // event"). Resolving the anchor's own date is a DB lookup, so it happens in ScheduleService, not here —
    // this schema only records which row to look up.
    anchorEntity: z.object({ type: z.enum(["calendar_event", "task"]), id: z.string() }),
  }),
  z.object({
    kind: z.literal("mileage"),
    // "Every 5,000 miles" — VEH-003 "mileage/time rules coexist" / VEH-007. Never produces calendar dates
    // (see this module's own doc comment); the task/rule this is attached to has `dueCondition: null` and
    // is instead surfaced via `nextMileageDue` below, evaluated against the referenced vehicle's latest
    // odometer observation.
    intervalMiles: z.number().int().min(1).max(200_000),
    vehicleProfileId: z.string(),
    // The odometer reading this interval counts from. Null means "count from the vehicle's very first
    // known odometer observation" — resolved by the caller (ScheduleService), not here, since that's a DB
    // lookup. Once a mileage-based task is completed, the caller re-anchors this to the mileage recorded
    // at completion time (see ScheduleService.completeTask's mileage branch) so the next interval counts
    // forward from "when this was last done," not from the vehicle's original odometer history.
    baselineMileage: z.number().int().min(0).nullable().default(null),
  }),
  z.object({
    kind: z.literal("mileage_or_calendar"),
    // VEH-003 "mileage/time rules coexist" — a composite rule for the "3 months OR 3,000 miles, whichever
    // comes first" idiom every real maintenance schedule (oil changes, tire rotations) actually uses.
    // Deliberately NOT a fully general pairing of "mileage" with an arbitrary nested RecurrenceRule (which
    // would need a recursive Zod schema and a parallel branch in every caller for combinations — "every
    // 2nd Tuesday OR 3,000 miles" — that don't correspond to anything a real maintenance interval
    // expresses): the calendar side here is a flat every-N-months cadence, which is the only calendar shape
    // this combination shows up as in practice. Scoped to vehicles specifically (vehicleProfileId, same as
    // "mileage" above) since that's the one domain this combination is meaningful for; see
    // `nextMileageOrCalendarDue` below for how the two sides combine into a single due/not-due answer.
    intervalMonths: IntervalSchema,
    intervalMiles: z.number().int().min(1).max(200_000),
    vehicleProfileId: z.string(),
    // Same "null = count from the vehicle's earliest odometer observation, resolved by the caller" meaning
    // as "mileage" above.
    baselineMileage: z.number().int().min(0).nullable().default(null),
  }),
]);
export type RecurrenceRule = z.infer<typeof RecurrenceRuleSchema>;

export interface OccurrenceWindow {
  /** Inclusive lower bound, YYYY-MM-DD. */
  from: string;
  /** Inclusive upper bound, YYYY-MM-DD. Omit when using `count` instead. */
  to?: string;
  /** Max number of occurrences to return, applied after `from`/`to` filtering. */
  count?: number;
}

// Guards every kind's loop against a pathological/corrupt rule (e.g. a hand-edited row with interval 0
// slipping past validation) spinning forever — no realistic UI-driven rule needs more than a year of daily
// occurrences expanded at once.
const MAX_ITERATIONS = 400;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseIsoDate(s: string): Date {
  return new Date(`${s}T00:00:00.000Z`);
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function addMonthsClamped(d: Date, months: number, dayOfMonth?: number): Date {
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth() + months;
  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = dayOfMonth ?? d.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, targetMonth, Math.min(day, lastDayOfTargetMonth)));
}

function isWeekend(d: Date): boolean {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function applyWeekendAdjustment(d: Date, adjustment: WeekendAdjustment | undefined): Date {
  if (!adjustment || adjustment === "none" || !isWeekend(d)) return d;
  const day = d.getUTCDay();
  if (adjustment === "next_weekday") return addDays(d, day === 0 ? 1 : 2);
  if (adjustment === "previous_weekday") return addDays(d, day === 0 ? -2 : -1);
  // "nearest_weekday" — Saturday shifts back to Friday, Sunday shifts forward to Monday (the common
  // "bank holiday" convention: never cross further than one day).
  return day === 6 ? addDays(d, -1) : addDays(d, 1);
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, nth: 1 | 2 | 3 | 4 | -1): Date {
  if (nth === -1) {
    const last = new Date(Date.UTC(year, month + 1, 0));
    const diff = (last.getUTCDay() - weekday + 7) % 7;
    return addDays(last, -diff);
  }
  const first = new Date(Date.UTC(year, month, 1));
  const diff = (weekday - first.getUTCDay() + 7) % 7;
  const firstMatch = addDays(first, diff);
  return addDays(firstMatch, (nth - 1) * 7);
}

/**
 * Pure recurrence expansion: given a rule, the anchor date it's computed relative to, and a window,
 * returns concrete YYYY-MM-DD occurrence dates (ascending, deduplicated). The anchor date's own meaning
 * depends on the rule kind:
 *  - every kind except "days_before": the row's own stored start/due date (the occurrence the rule was
 *    originally set relative to — e.g. dayOfMonth/weekday default from it when not explicit).
 *  - "days_before": the *resolved external anchor's* date (already looked up by the caller), not the
 *    row's own date — the single computed occurrence is `anchorDate - days`.
 */
export function expandOccurrences(rule: RecurrenceRule, anchorDate: string, window: OccurrenceWindow): string[] {
  // "mileage"/"mileage_or_calendar" rules produce no calendar-only date series (see this module's own doc
  // comment) — a caller that reaches here with one is a bug (e.g. previewing occurrences without checking
  // `ruleIsMileageBased`/`ruleIsMileageOrCalendarBased` first), not a case to silently return `[]` for,
  // which would look like "no upcoming occurrences" rather than "wrong function called."
  if (rule.kind === "mileage") {
    throw new Error("expandOccurrences does not support 'mileage' rules — use nextMileageDue instead.");
  }
  if (rule.kind === "mileage_or_calendar") {
    throw new Error("expandOccurrences does not support 'mileage_or_calendar' rules — use nextMileageOrCalendarDue instead.");
  }
  const anchor = parseIsoDate(anchorDate);
  const from = parseIsoDate(window.from);
  const to = window.to ? parseIsoDate(window.to) : null;
  const maxCount = window.count ?? MAX_ITERATIONS;
  const results: string[] = [];

  function push(d: Date): boolean {
    if (d.getTime() < from.getTime()) return true; // keep iterating — may not have reached the window yet
    if (to && d.getTime() > to.getTime()) return false; // past the window — stop
    const iso = isoDate(d);
    if (results[results.length - 1] !== iso) results.push(iso);
    return results.length < maxCount;
  }

  switch (rule.kind) {
    case "daily": {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const raw = addDays(anchor, i * rule.interval);
        if (to && raw.getTime() > to.getTime()) break;
        if (!push(applyWeekendAdjustment(raw, rule.weekendAdjustment))) break;
      }
      break;
    }
    case "weekly": {
      const days = rule.daysOfWeek.length > 0 ? [...rule.daysOfWeek].sort((a, b) => a - b) : [anchor.getUTCDay()];
      const anchorWeekStart = addDays(anchor, -anchor.getUTCDay());
      for (let week = 0; week < MAX_ITERATIONS; week += rule.interval) {
        const weekStart = addDays(anchorWeekStart, week * 7);
        if (to && weekStart.getTime() > to.getTime()) break;
        let stop = false;
        for (const day of days) {
          const raw = addDays(weekStart, day);
          if (raw.getTime() < anchor.getTime()) continue; // never emit before the rule's own anchor
          if (!push(applyWeekendAdjustment(raw, rule.weekendAdjustment))) {
            stop = true;
            break;
          }
        }
        if (stop) break;
      }
      break;
    }
    case "monthly": {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const raw = addMonthsClamped(anchor, i * rule.interval, rule.dayOfMonth ?? undefined);
        if (to && raw.getTime() > to.getTime()) break;
        if (!push(applyWeekendAdjustment(raw, rule.weekendAdjustment))) break;
      }
      break;
    }
    case "yearly": {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const raw = addMonthsClamped(anchor, i * rule.interval * 12);
        if (to && raw.getTime() > to.getTime()) break;
        if (!push(applyWeekendAdjustment(raw, rule.weekendAdjustment))) break;
      }
      break;
    }
    case "nth_weekday": {
      const anchorMonthIndex = anchor.getUTCFullYear() * 12 + anchor.getUTCMonth();
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        const monthIndex = anchorMonthIndex + i * rule.interval;
        const year = Math.floor(monthIndex / 12);
        const month = ((monthIndex % 12) + 12) % 12;
        const raw = nthWeekdayOfMonth(year, month, rule.weekday, rule.nth);
        if (to && raw.getTime() > to.getTime()) break;
        if (raw.getTime() < anchor.getTime()) continue;
        if (!push(applyWeekendAdjustment(raw, rule.weekendAdjustment))) break;
      }
      break;
    }
    case "business_day": {
      let cursor = applyWeekendAdjustment(anchor, "next_weekday");
      let stepped = 0;
      for (let i = 0; i < MAX_ITERATIONS * 2; i++) {
        if (to && cursor.getTime() > to.getTime()) break;
        if (stepped % rule.interval === 0) {
          if (!push(cursor)) break;
        }
        stepped++;
        do {
          cursor = addDays(cursor, 1);
        } while (isWeekend(cursor));
      }
      break;
    }
    case "days_before": {
      // A single computed date, not a series — see this function's own doc comment. Deliberately bypasses
      // `push()`'s `window.from` lower-bound check: that check exists to stop an *ascending* loop once it
      // reaches the requested window, but this date is computed *backward* from the anchor (anchor - days),
      // so it will almost always fall before `from` when the caller (reasonably) passes the anchor itself
      // as `from` — that's not "not yet in the window," it's the entire point of "X days before." Only
      // `to` (an upper bound) and `count` still apply.
      const raw = addDays(anchor, -rule.days);
      if ((!to || raw.getTime() <= to.getTime()) && results.length < maxCount) {
        results.push(isoDate(raw));
      }
      break;
    }
  }

  return results;
}

/** Resolves the concrete anchor date a rule should default day-of-month/weekday/etc. from. For every kind
 * except "days_before" this is just the row's own date; "days_before" instead needs its anchor entity's
 * date already resolved by the caller (see expandOccurrences's own doc comment). */
export function ruleNeedsExternalAnchor(rule: RecurrenceRule): rule is Extract<RecurrenceRule, { kind: "days_before" }> {
  return rule.kind === "days_before";
}

/** True for a "mileage" rule — the caller must route it to `nextMileageDue` instead of
 * `expandOccurrences`/`ruleNeedsExternalAnchor`'s date-based paths. */
export function ruleIsMileageBased(rule: RecurrenceRule): rule is Extract<RecurrenceRule, { kind: "mileage" }> {
  return rule.kind === "mileage";
}

/** True for a "mileage_or_calendar" rule — route it to `nextMileageOrCalendarDue` instead of
 * `expandOccurrences` (calendar-only) or `nextMileageDue` (mileage-only) alone; it needs both a resolved
 * calendar anchor date AND a resolved current-mileage reading, unlike either pure kind. */
export function ruleIsMileageOrCalendarBased(rule: RecurrenceRule): rule is Extract<RecurrenceRule, { kind: "mileage_or_calendar" }> {
  return rule.kind === "mileage_or_calendar";
}

export interface MileageDueStatus {
  /** The odometer reading this interval counts forward from (`rule.baselineMileage`, or the caller-supplied
   * fallback when that's null). */
  baselineMileage: number;
  /** The next odometer reading at which this maintenance item comes due. */
  dueAtMileage: number;
  /** The vehicle's latest known odometer reading, or null if it has none yet. */
  currentMileage: number | null;
  /** `dueAtMileage - currentMileage`, clamped to 0 once due; null when there's no current reading to
   * compare against (an unknown vehicle can't be judged "due" or "not due" — see isDue below). */
  milesRemaining: number | null;
  /** Only ever true once a real odometer reading is known and it has reached/passed `dueAtMileage` —
   * never guessed from elapsed time, since this rule is explicitly usage-based, not date-based. */
  isDue: boolean;
}

/**
 * Pure mileage-recurrence evaluation — the "mileage" rule kind's equivalent of `expandOccurrences`, but
 * evaluated against a single current odometer reading rather than expanded into a date series (a mileage
 * interval has no "next 5 occurrences" the way a calendar rule does — only "how far until the next one,"
 * which changes with every new odometer reading, not with the passage of time).
 *
 * `resolvedBaselineMileage` is the caller-resolved value of `rule.baselineMileage ?? <vehicle's earliest
 * known odometer observation>` — resolving that fallback is a DB lookup, so (consistent with
 * `resolveDaysBeforeAnchorDate` in ScheduleService for the "days_before" kind) it happens in the caller,
 * not here. When the vehicle has no odometer observations at all yet, the caller has nothing to resolve
 * the baseline to; pass 0 in that case and treat the resulting status's `currentMileage: null` as "not
 * enough data yet" rather than acting on `dueAtMileage`.
 */
export function nextMileageDue(rule: Extract<RecurrenceRule, { kind: "mileage" }>, resolvedBaselineMileage: number, currentMileage: number | null): MileageDueStatus {
  const baseline = resolvedBaselineMileage;
  // Deliberately always exactly one interval past the baseline, never recomputed forward from the current
  // reading — the baseline only moves when the item is actually completed (ScheduleService.completeTask's
  // mileage branch re-anchors it to the mileage recorded at completion). So a vehicle that's driven well
  // past its due point without the item being marked done stays "due" (increasingly overdue, mirroring how
  // an unpaid bill stays "overdue" rather than silently rolling forward to the next cycle) instead of this
  // function quietly advancing the due point out from under an item nobody serviced yet.
  const dueAtMileage = baseline + rule.intervalMiles;
  return {
    baselineMileage: baseline,
    dueAtMileage,
    currentMileage,
    milesRemaining: currentMileage != null ? Math.max(0, dueAtMileage - currentMileage) : null,
    isDue: currentMileage != null && currentMileage >= dueAtMileage,
  };
}

/**
 * The "mileage_or_calendar" rule kind's calendar-only due date — `rule.intervalMonths` past
 * `calendarAnchorDate`, same clamped-day-of-month arithmetic `expandOccurrences`'s "monthly" case uses (a
 * flat every-N-months cadence, not a full monthly rule with its own dayOfMonth/weekendAdjustment options —
 * see this rule kind's own doc comment on why). Exported on its own (not just inlined into
 * `nextMileageOrCalendarDue` below) because `ScheduleService.completeTask` needs this exact value to
 * advance the stored due date on completion, without needing the mileage side's DB-resolved
 * baseline/current reading just to compute it.
 */
export function nextMileageOrCalendarCalendarDate(rule: Extract<RecurrenceRule, { kind: "mileage_or_calendar" }>, calendarAnchorDate: string): string {
  return isoDate(addMonthsClamped(parseIsoDate(calendarAnchorDate), rule.intervalMonths));
}

export interface MileageOrCalendarDueStatus {
  /** `nextMileageOrCalendarCalendarDate`'s result — the calendar side's own due date, independent of mileage. */
  calendarDueDate: string;
  /** The mileage side, evaluated exactly like a plain "mileage" rule (same `nextMileageDue` under the hood). */
  mileage: MileageDueStatus;
  /** True the moment EITHER side is due — "whichever comes first," never both required. */
  isDue: boolean;
}

/**
 * Pure combined evaluation for the "mileage_or_calendar" rule kind — like `nextMileageDue`, this needs the
 * caller to have already resolved the DB-dependent bits (the calendar anchor date, the baseline mileage
 * fallback, the vehicle's current odometer reading); see ScheduleService.mileageOrCalendarStatusFor for
 * that resolution. `today` is caller-supplied (not read from the system clock in here) for the same
 * "no hidden clock reads in a pure function" discipline as the rest of this module — every other date
 * comparison in this file is relative to a caller-supplied window, not `Date.now()`.
 */
export function nextMileageOrCalendarDue(
  rule: Extract<RecurrenceRule, { kind: "mileage_or_calendar" }>,
  calendarAnchorDate: string,
  resolvedBaselineMileage: number,
  currentMileage: number | null,
  today: string,
): MileageOrCalendarDueStatus {
  const calendarDueDate = nextMileageOrCalendarCalendarDate(rule, calendarAnchorDate);
  const mileage = nextMileageDue({ kind: "mileage", intervalMiles: rule.intervalMiles, vehicleProfileId: rule.vehicleProfileId, baselineMileage: rule.baselineMileage }, resolvedBaselineMileage, currentMileage);
  return {
    calendarDueDate,
    mileage,
    isDue: calendarDueDate <= today || mileage.isDue,
  };
}
