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
  const [startH, startM] = prefs.quietHoursStart.split(":").map(Number);
  const [endH, endM] = prefs.quietHoursEnd.split(":").map(Number);
  const { hour, minute } = localTimeParts(now, timezone);
  const nowMinutes = hour * 60 + minute;
  const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
  const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes; // wraps past midnight, e.g. 22:00-07:00
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
