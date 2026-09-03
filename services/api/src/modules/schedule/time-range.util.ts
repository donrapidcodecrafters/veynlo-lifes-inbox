import type { TemporalValue } from "@veynlo/core";

export interface EffectiveRange {
  startMs: number;
  endMs: number;
}

// Calendar apps universally need *some* default duration for an event whose end time was never captured
// (a discovered "Dentist appointment at 3pm" email rarely states an end time) — without one, overlap
// detection could only ever fire on two events sharing the *exact* same instant, which would make this
// feature nearly useless. 60 minutes matches the common calendar-UI default (Google Calendar's own "no end
// time specified" default). This is a deliberate, documented estimate, not a fabricated fact recorded
// anywhere — it only affects which pairs get compared for overlap/availability checks, never what's stored
// or shown as the event's own duration.
export const DEFAULT_EVENT_DURATION_MS = 60 * 60_000;

/**
 * Shared by ConflictService (true-overlap and school-transport detection) and the adult-availability
 * heuristic (adult-availability.ts) — pulled out of ConflictService so both can compute "what time range
 * does this event actually occupy" the exact same way rather than risking two subtly different
 * implementations drifting apart.
 */
export function effectiveRange(event: { start: TemporalValue; end: TemporalValue | null; isAllDay: boolean }): EffectiveRange | null {
  if (event.isAllDay) {
    if (event.start.precision !== "date" || !event.start.date) return null;
    const startMs = Date.parse(`${event.start.date}T00:00:00.000Z`);
    const endMs = event.end?.precision === "date" && event.end.date ? Date.parse(`${event.end.date}T00:00:00.000Z`) + 86_400_000 : startMs + 86_400_000;
    return { startMs, endMs };
  }
  // Never fabricate a time range from a "date"-only, "month", "approximate", or "unknown" precision
  // non-all-day event — that would mean guessing a time of day the evidence never established, which is
  // exactly what TemporalValue's precision field exists to prevent (see temporal.util.ts's own comment).
  if (event.start.precision !== "instant" || !event.start.instantUtc) return null;
  const startMs = Date.parse(event.start.instantUtc);
  const endMs = event.end?.precision === "instant" && event.end.instantUtc ? Date.parse(event.end.instantUtc) : startMs + DEFAULT_EVENT_DURATION_MS;
  return { startMs, endMs: Math.max(endMs, startMs) };
}

export function rangesOverlap(a: EffectiveRange, b: EffectiveRange): boolean {
  return a.startMs < b.endMs && b.startMs < a.endMs;
}
