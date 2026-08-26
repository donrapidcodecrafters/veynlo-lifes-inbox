/**
 * §NOT-002 — quiet hours. Pulled out as a pure function (no DB/DI) so the
 * midnight-wrap edge case is trivially unit-testable.
 */
export function isWithinQuietHours(
  prefs: { quietHoursStart: string | null; quietHoursEnd: string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!prefs?.quietHoursStart || !prefs?.quietHoursEnd) return false;
  const [startH, startM] = prefs.quietHoursStart.split(":").map(Number);
  const [endH, endM] = prefs.quietHoursEnd.split(":").map(Number);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = (startH ?? 0) * 60 + (startM ?? 0);
  const endMinutes = (endH ?? 0) * 60 + (endM ?? 0);
  if (startMinutes === endMinutes) return false;
  return startMinutes < endMinutes
    ? nowMinutes >= startMinutes && nowMinutes < endMinutes
    : nowMinutes >= startMinutes || nowMinutes < endMinutes; // wraps past midnight, e.g. 22:00-07:00
}
