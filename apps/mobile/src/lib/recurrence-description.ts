import type { RecurrenceRule } from "@veynlo/core";

/** TASK-003 — mirrors apps/web's identical `describeRecurrence` (life/page.tsx) for list-row summaries. */
export function describeRecurrence(rule: RecurrenceRule): string {
  switch (rule.kind) {
    case "daily":
      return rule.interval === 1 ? "Repeats daily" : `Repeats every ${rule.interval} days`;
    case "weekly":
      return rule.interval === 1 ? "Repeats weekly" : `Repeats every ${rule.interval} weeks`;
    case "monthly":
      return rule.interval === 1 ? "Repeats monthly" : `Repeats every ${rule.interval} months`;
    case "yearly":
      return rule.interval === 1 ? "Repeats yearly" : `Repeats every ${rule.interval} years`;
    case "nth_weekday":
      return "Repeats monthly";
    case "business_day":
      return "Repeats on business days";
    case "days_before":
      return "Repeats relative to another date";
    case "mileage":
      // VEH-007 — mirrors apps/web's identical describeRecurrence mileage case; see its own comment.
      return `Repeats every ${rule.intervalMiles.toLocaleString()} miles`;
    case "mileage_or_calendar":
      // VEH-003 — mirrors apps/web's identical describeRecurrence case; see its own comment.
      return `Repeats every ${rule.intervalMonths} month(s) or ${rule.intervalMiles.toLocaleString()} miles, whichever comes first`;
  }
}
