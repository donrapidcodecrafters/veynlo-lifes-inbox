import { sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
  /**
   * A fixed UTC offset, not a zone name.
   *
   * `Intl` understands only IANA zones, and the catch below turns anything it rejects into 0 — silently
   * UTC. So a caller holding a real, unambiguous offset got a time that was WRONG rather than an error:
   * schema.org reservation markup states "2026-04-15T18:30:00-07:00", and passing that offset through
   * filed an 18:30 departure as 18:30Z, seven hours out. A flight filed at the wrong hour is worse than
   * one not filed at all, because somebody plans around it.
   *
   * Handled here rather than at that one call site: any caller holding an offset has the same problem, and
   * a rule implemented once and omitted at its siblings is the most common defect shape in this codebase.
   */
  const fixedOffset = /^([+-])(\d{2}):?(\d{2})$/.exec(timeZone.trim());
  if (fixedOffset) {
    const sign = fixedOffset[1] === "-" ? -1 : 1;
    const hours = Number(fixedOffset[2]);
    const minutes = Number(fixedOffset[3]);
    // An impossible offset falls through to Intl, which rejects it — better UTC than a wild number.
    if (hours <= 14 && minutes <= 59) return sign * (hours * 60 + minutes) * 60_000;
  }

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

/**
 * The YYYY-MM-DD calendar date an instant falls on, in a given zone.
 *
 * The counterpart to `localDayWindow`: that answers "which instants are in this local day", this answers
 * "which local day is this". Both are needed because rows carry two different kinds of temporal value.
 */
export function localDateIso(at: Date, timeZone: string | null | undefined): string {
  const { year, month, day } = localDateParts(at, timeZone || "UTC");
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Does a temporal value fall on the given local day?
 *
 * A date-only value is a CALENDAR DATE, and comparing it to an instant window is a category error. Its
 * sort key is UTC midnight, so for anyone west of UTC it sits before their day has started — a Chicago
 * user's September 12th begins at 05:00Z, and an all-day event dated the 12th sorts at 00:00Z, five hours
 * earlier, landing it in the window for the 11th. East of UTC the same mismatch pushes it the other way.
 *
 * The effect was a whole day of error on exactly the values a user is most likely to have entered by hand:
 * an all-day event, a bill due "on the 12th", a task with a date and no time. Measured, not reasoned
 * about — see local-day-date-precision.test.ts, which fails for Chicago, Los Angeles and Auckland and
 * passes only for UTC.
 *
 * So a date-only value is compared BY DATE, and only an instant is compared against the window.
 */
export function temporalFallsOnLocalDay(
  value: { precision?: string | null; date?: string | null; instantUtc?: string | null } | null | undefined,
  window: LocalDayWindow,
  localDate: string,
): boolean {
  if (!value) return false;
  if (value.precision === "date") return value.date === localDate;
  if (value.instantUtc) {
    const at = new Date(value.instantUtc);
    return at >= window.startOfDay && at <= window.endOfDay;
  }
  return false;
}

/**
 * A SQL predicate for "this row falls on the given local day", for a table whose temporal value is stored
 * as jsonb alongside an instant sort column.
 *
 * Deliberately excludes date-precision rows from the instant comparison rather than widening the window.
 * Widening would pull in genuine instants from the neighbouring day, trading one wrong answer for another;
 * a date-only value simply is not an instant and has to be matched on the date it carries.
 */
export function fallsOnLocalDaySql(
  temporalColumn: AnyPgColumn,
  sortColumn: AnyPgColumn,
  window: LocalDayWindow,
  localDate: string,
): SQL {
  return sql`(
    (${temporalColumn} ->> 'precision' IS DISTINCT FROM 'date'
      AND ${sortColumn} >= ${window.startOfDay} AND ${sortColumn} <= ${window.endOfDay})
    OR (${temporalColumn} ->> 'precision' = 'date' AND ${temporalColumn} ->> 'date' = ${localDate})
  )`;
}

/**
 * A SQL predicate for "this row is due on or before the given local day".
 *
 * Separate from `fallsOnLocalDaySql` because it is a different question, and collapsing the two would get
 * one of them wrong. The Today list includes tasks that are OVERDUE as well as those due today, so its
 * bound is one-sided — and for a date-only value that means comparing calendar dates, where a string
 * comparison on YYYY-MM-DD is exactly a chronological one.
 */
export function dueOnOrBeforeLocalDaySql(
  temporalColumn: AnyPgColumn,
  sortColumn: AnyPgColumn,
  window: LocalDayWindow,
  localDate: string,
): SQL {
  return sql`(
    (${temporalColumn} ->> 'precision' IS DISTINCT FROM 'date' AND ${sortColumn} <= ${window.endOfDay})
    OR (${temporalColumn} ->> 'precision' = 'date' AND ${temporalColumn} ->> 'date' <= ${localDate})
  )`;
}
