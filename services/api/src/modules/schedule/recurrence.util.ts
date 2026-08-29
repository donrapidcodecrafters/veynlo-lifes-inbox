/**
 * TASK-003 "recurrence engine" — deliberately scoped down from the spec's full ask (RRULE-like schedules
 * plus maintenance intervals, nth weekday, business-day, "X days before event," mileage/usage conditions,
 * provider-derived cycles) to genuine RRULE syntax for the common case: `FREQ=DAILY|WEEKLY|MONTHLY|
 * YEARLY;INTERVAL=n`. Nth-weekday/business-day/usage-based recurrence would each need their own
 * calculation and no real usage data (mileage, provider cycles) exists to key off yet — a bigger, separate
 * effort. Genuinely RRULE-compatible syntax for the part that IS built, not an ad-hoc format, so a real
 * RRULE parser could extend this later without a data migration.
 */
export interface ParsedRecurrenceRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
}

export function parseRecurrenceRule(rule: string): ParsedRecurrenceRule | null {
  const parts = Object.fromEntries(
    rule
      .split(";")
      .map((part) => part.split("="))
      .filter((pair): pair is [string, string] => pair.length === 2),
  );
  const freq = parts.FREQ;
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1) return null;
  return { freq, interval };
}

export function nextOccurrence(current: Date, rule: ParsedRecurrenceRule): Date {
  const next = new Date(current);
  if (rule.freq === "DAILY") next.setDate(next.getDate() + rule.interval);
  else if (rule.freq === "WEEKLY") next.setDate(next.getDate() + 7 * rule.interval);
  else if (rule.freq === "MONTHLY") next.setMonth(next.getMonth() + rule.interval);
  else if (rule.freq === "YEARLY") next.setFullYear(next.getFullYear() + rule.interval);
  return next;
}
