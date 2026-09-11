/**
 * The UTC instants that bound a user's LOCAL calendar day.
 *
 * "Today" views were computing their window with `Date.UTC(now.getUTCFullYear(), ...)` — the UTC calendar
 * day — while `users.timezone` sat right there, populated (the demo accounts are all `America/New_York`)
 * and already used for quiet hours and data export.
 *
 * For anyone not near UTC that makes the primary "what's happening today" surface wrong for part of every
 * day. In `America/New_York` (UTC−4 in summer) the UTC day rolls over at 20:00 local, so from 20:00 until
 * midnight the view showed **tomorrow's** items and hid the rest of today's. Four hours out of every
 * twenty-four, every day, on the screen the app opens to.
 *
 * Resolving a zone offset is not a fixed number — it changes with DST — so the offset is measured AT the
 * instant in question rather than assumed, and applied twice: the first correction can land on the other
 * side of a DST boundary (on a spring-forward day, local midnight computed with the previous day's offset
 * is off by an hour), and re-measuring at the corrected instant settles it.
 *
 * An invalid or unrecognised zone falls back to UTC rather than throwing, matching quiet-hours.ts's
 * `localTimeParts` — a malformed stored value should not take a screen down.
 */

/** How far the wall clock in `timeZone` is ahead of UTC at `instant`, in milliseconds. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(instant);
    const at = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    // `hour12: false` reports midnight as 24 on some engines — the same quirk quiet-hours.ts guards.
    const wallClockAsUtc = Date.UTC(at("year"), at("month") - 1, at("day"), at("hour") % 24, at("minute"), at("second"));
    return wallClockAsUtc - instant.getTime();
  } catch {
    return 0;
  }
}

/** The local calendar date in `timeZone` at `instant`, as {year, month, day}. */
function localDateParts(instant: Date, timeZone: string): { year: number; month: number; day: number } {
  try {
    // en-CA formats as YYYY-MM-DD, which parses without ambiguity.
    const [year, month, day] = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .format(instant)
      .split("-")
      .map(Number);
    return { year: year!, month: month!, day: day! };
  } catch {
    return { year: instant.getUTCFullYear(), month: instant.getUTCMonth() + 1, day: instant.getUTCDate() };
  }
}

export interface LocalDayWindow {
  /** The UTC instant at which the user's local day began. */
  startOfDay: Date;
  /** The UTC instant at which it ends — exclusive, and NOT always 24h later (DST days are 23 or 25). */
  endOfDay: Date;
}

/** The window covering the local calendar day that `now` falls in, for a user in `timeZone`. */
export function localDayWindow(now: Date, timeZone: string | null | undefined): LocalDayWindow {
  const zone = timeZone || "UTC";
  const today = localDateParts(now, zone);
  const startOfDay = startOfLocalDate(today, zone);

  // Tomorrow's local midnight, not start + 24h: a spring-forward day is 23 hours long and a fall-back day
  // is 25, so a fixed 24-hour window either misses an hour of the day or bleeds an hour into the next one.
  const tomorrowUtc = new Date(Date.UTC(today.year, today.month - 1, today.day) + 24 * 60 * 60 * 1000);
  const tomorrow = { year: tomorrowUtc.getUTCFullYear(), month: tomorrowUtc.getUTCMonth() + 1, day: tomorrowUtc.getUTCDate() };
  return { startOfDay, endOfDay: startOfLocalDate(tomorrow, zone) };
}

/** The UTC instant of 00:00 local time on a given local date. */
function startOfLocalDate(date: { year: number; month: number; day: number }, timeZone: string): Date {
  return localWallClockToInstant({ ...date, hour: 0, minute: 0 }, timeZone);
}

/**
 * The UTC instant at which a given wall-clock time occurs in a zone.
 *
 * The generalisation of startOfLocalDate, extracted rather than copied because the DST correction is the
 * entire difficulty here and a second copy is how a rule ends up fixed in one place and broken in the
 * other. Exported for ingestion/temporal.util.ts, which needs to express "2:00 PM in America/Los_Angeles
 * on this date" and previously had no way to ask for it — so it dropped the time.
 *
 * The offset is MEASURED at the instant in question and then re-measured, for the same reason as before: a
 * zone offset is not a constant, and the first correction can land on the far side of a DST boundary. On a
 * spring-forward morning the hour 02:00-03:00 does not exist at all; the second measurement resolves such
 * a time forward into the hour that does, which is what consumer calendars do with it.
 */
export function localWallClockToInstant(
  at: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const wallClock = Date.UTC(at.year, at.month - 1, at.day, at.hour, at.minute);
  let instant = new Date(wallClock - zoneOffsetMs(new Date(wallClock), timeZone));
  // Re-measure at the corrected instant: across a DST boundary the first offset can be the wrong side's.
  instant = new Date(wallClock - zoneOffsetMs(instant, timeZone));
  return instant;
}
