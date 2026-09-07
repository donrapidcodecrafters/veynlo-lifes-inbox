/**
 * §NOT-002 — quiet hours. Pulled out as a pure function (no DB/DI) so the
 * midnight-wrap edge case is trivially unit-testable.
 *
 * `quietHoursStart`/`quietHoursEnd` are user-entered local wall-clock times (e.g. "22:00" means 10pm in
 * the user's own timezone, not the server's) — found live via a real audit that this previously evaluated
 * `now.getHours()` directly, i.e. always against the API server's own timezone, so a user's quiet hours
 * fired at the wrong local time whenever they weren't in the server's timezone. `timezone` should be the
 * user's `users.timezone` column value (an IANA zone name, e.g. "America/Los_Angeles"); defaults to "UTC"
 * to match this column's own schema default for a caller that hasn't loaded it.
 */
export function isWithinQuietHours(
  prefs: { quietHoursStart: string | null; quietHoursEnd: string | null } | null | undefined,
  now: Date = new Date(),
  timezone = "UTC",
): boolean {
  if (!prefs?.quietHoursStart || !prefs?.quietHoursEnd) return false;
  const startMinutes = minutesFromWallClock(prefs.quietHoursStart);
  const endMinutes = minutesFromWallClock(prefs.quietHoursEnd);
  if (startMinutes === null || endMinutes === null) return false;
  const { hour, minute } = localTimeParts(now, timezone);
  const nowMinutes = hour * 60 + minute;
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes; // wraps past midnight, e.g. 22:00-07:00
}

/**
 * Minutes past midnight for a "HH:MM" wall-clock string, or null if it is not one.
 *
 * The old parse was `value.split(":").map(Number)` with `?? 0` defaults, which is wrong in a way that hid
 * itself. `"notatime".split(":")` is `["notatime"]`, `Number("notatime")` is NaN, and `NaN ?? 0` is NaN —
 * nullish coalescing catches null and undefined, not NaN. Every comparison against NaN is false, so the
 * function fell through to its wrap-past-midnight branch and silently computed the window as 00:00 to
 * whatever the END time said. Found live: "notatime" typed into the Start field muted notifications from
 * midnight, with nothing anywhere reporting a problem.
 *
 * Returning null rather than a default is the point. There is no sensible default for "the user's quiet
 * hours are unreadable" — 0 means midnight, which is a real and very wrong answer — so the caller treats it
 * as no quiet hours and delivers the notification. An unreadable preference should fail towards the user
 * hearing from the app, not towards silence.
 */
function minutesFromWallClock(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** An invalid/unrecognized IANA zone name falls back to UTC rather than throwing — a malformed stored value shouldn't crash delivery. */
function localTimeParts(date: Date, timezone: string): { hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "numeric", hour12: false }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return { hour: hour % 24, minute }; // some engines report midnight as hour "24" in hour12:false mode
  } catch {
    return { hour: date.getUTCHours(), minute: date.getUTCMinutes() };
  }
}
