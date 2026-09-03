import { and, gte, inArray, lte, ne } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import type { HouseholdService } from "../household/household.service";
import { effectiveRange } from "./time-range.util";

export interface AdultBusyInterval {
  startMs: number;
  endMs: number;
}

// Matches ConflictService.detectOverlaps'/schoolTransportConflicts' own ±1-day candidate-window padding —
// an event whose *start* falls just outside the requested window can still overlap into it (e.g. an
// all-day or long event), so the DB-side query pads generously; the precise ms-range filtering happens in
// JS below regardless.
const SEARCH_PADDING_MS = 24 * 60 * 60_000;

/**
 * Household adult-availability heuristic — the data need behind ConflictService.schoolTransportConflicts'
 * "is an adult actually free to drive" check (spec CAL-003/§25's "Family Transport Conflicts" gap; see
 * that method's own doc comment for the product framing).
 *
 * Returns, for every ADULT household member (`household_owner`/`adult_member` roles with an active
 * membership and a real `userId` — see HouseholdService.activeAdultUserIds; `dependent_profile` rows and
 * every other principal role are never candidate drivers), the set of busy intervals THEIR OWN
 * `calendar_events` establish inside `[windowStartMs, windowEndMs)`.
 *
 * Privacy discipline — spec's CAL-001 line, quoted verbatim: "Household availability may expose 'busy'
 * without exposing private event title/details." This function is the one place in the app that
 * deliberately looks at an adult's PRIVATE events (bypassing the `visibility !== "private"` filter every
 * other household-facing read in this codebase enforces — see ScheduleService.ownerOrDelegatedHousehold's
 * own doc comment on that filter) to compute their availability, because an adult's own calendar
 * determines when THEY are free regardless of whether they marked a given event visible to the rest of the
 * household. What makes that safe is the return type: every interval is exactly `{ startMs, endMs }` and
 * NOTHING else — no title, location, or any other selected column ever leaves the SQL query this function
 * runs, so there is structurally no event content for a caller (of any identity, including a household
 * member other than the adult in question) to ever receive back. Only a boolean-shaped fact — "busy during
 * this window, yes/no" — is ever derived from it.
 *
 * Best-effort by nature, and documented as such rather than presented as a scheduling guarantee: an adult
 * "free" per their calendar might still be genuinely unavailable for reasons no calendar entry captures
 * (sick, no license, out of gas, at a desk job with no calendar block for it), and one who's
 * calendar-idle-but-actually-occupied will still show as "free" here. This surfaces a REAL conflict earlier
 * than never checking at all — it does not, and cannot, guarantee a driver actually shows up.
 */
export async function householdAdultBusyIntervals(
  db: Database,
  households: HouseholdService,
  householdId: string,
  windowStartMs: number,
  windowEndMs: number,
): Promise<Map<string, AdultBusyInterval[]>> {
  const adultUserIds = await households.activeAdultUserIds(householdId);
  const result = new Map<string, AdultBusyInterval[]>(adultUserIds.map((id) => [id, []]));
  if (adultUserIds.length === 0) return result;

  // Deliberately selects only the columns this function ever touches — start/end/isAllDay/ownerUserId —
  // never `title` or `location`, so a coding mistake later in this function literally cannot leak one:
  // the encrypted content is never even pulled off the wire here.
  const events = await db
    .select({
      ownerUserId: schema.calendarEvents.ownerUserId,
      start: schema.calendarEvents.start,
      end: schema.calendarEvents.end,
      isAllDay: schema.calendarEvents.isAllDay,
    })
    .from(schema.calendarEvents)
    .where(
      and(
        inArray(schema.calendarEvents.ownerUserId, adultUserIds),
        ne(schema.calendarEvents.status, "canceled"),
        gte(schema.calendarEvents.startSort, new Date(windowStartMs - SEARCH_PADDING_MS)),
        lte(schema.calendarEvents.startSort, new Date(windowEndMs + SEARCH_PADDING_MS)),
      ),
    );

  for (const event of events) {
    const range = effectiveRange(event);
    if (!range) continue;
    if (range.endMs <= windowStartMs || range.startMs >= windowEndMs) continue; // outside the requested window entirely
    result.get(event.ownerUserId)?.push({ startMs: range.startMs, endMs: range.endMs });
  }
  return result;
}

/** True if none of `intervals` overlaps `[startMs, endMs)` — i.e. this adult has no known busy time during that window. */
export function isAdultFreeDuring(intervals: AdultBusyInterval[], startMs: number, endMs: number): boolean {
  return !intervals.some((busy) => busy.startMs < endMs && startMs < busy.endMs);
}
