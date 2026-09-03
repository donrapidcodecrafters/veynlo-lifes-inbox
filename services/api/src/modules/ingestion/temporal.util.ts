import { unknownTemporal, type TemporalValue } from "@veynlo/core";

interface ExtractedDate {
  iso_date: string | null;
  approximate_text: string | null;
}

/** Converts a model's extracted-date shape into a TemporalValue without ever fabricating precision the evidence didn't support. */
export function toTemporalValue(extracted: ExtractedDate | null, timezone: string | null = null): TemporalValue {
  if (!extracted) return unknownTemporal();
  if (extracted.iso_date) {
    return { precision: "date", instantUtc: null, date: extracted.iso_date, timezone, sourceText: null };
  }
  if (extracted.approximate_text) {
    return { precision: "approximate", instantUtc: null, date: null, timezone, sourceText: extracted.approximate_text };
  }
  return unknownTemporal();
}

export function temporalToSortDate(value: TemporalValue): Date | null {
  if (value.precision === "date" && value.date) return new Date(`${value.date}T00:00:00Z`);
  if (value.precision === "instant" && value.instantUtc) return new Date(value.instantUtc);
  return null;
}

/** The plain YYYY-MM-DD calendar date a TemporalValue falls on — only "date" and "instant" precision are
 * usable (never fabricate a date from an approximate/month/unknown value). Used for CAL-003's
 * email-vs-calendar date-disagreement check (IngestionService.findCrossSourceDateDisagreement), which
 * compares CALENDAR DATES, not exact instants — two events an hour apart on the same day are a time
 * mismatch, not the "this email says a different DATE" disagreement the spec calls out. */
export function temporalCalendarDate(value: TemporalValue): string | null {
  if (value.precision === "date" && value.date) return value.date;
  if (value.precision === "instant" && value.instantUtc) return value.instantUtc.slice(0, 10);
  return null;
}

/**
 * CAL-002 "reminder defaults" — the one place every calendar-event writer (IngestionService's discovered-
 * event extraction/feed sync, ScheduleService.createEvent, AutomationService's add_calendar_event action)
 * computes the default lead time so they can't drift from each other. An all-day event's "start" has no
 * time component to count backward from in any meaningful way, so its default is a full day ahead (the
 * night-before reminder pattern every consumer calendar app uses) rather than 60 minutes before midnight.
 */
export function defaultReminderMinutes(isAllDay: boolean): number {
  return isAllDay ? 1440 : 60;
}
