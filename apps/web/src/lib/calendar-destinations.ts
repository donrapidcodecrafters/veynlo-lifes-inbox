/**
 * CAL-001/CAL-002 shared constants — used by both the event detail page's write-back push control and the
 * Inbox page's "Add to calendar" destination picker, so the two don't drift out of sync with each other or
 * with the Connections page's own provider labels (apps/web/src/app/(app)/connections/page.tsx keeps its
 * own copy for its wider connector list; this one is scoped to just the two write-back-capable providers).
 */
export const PROVIDER_LABEL: Record<string, string> = {
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
};

/** Options for `reminderMinutesBefore` — capped at 3 days (4320 minutes), matching the backend DTOs'
 * validation range (AddToCalendarDtoSchema/SetEventReminderDtoSchema/CreateEventDtoSchema). */
export const REMINDER_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "At the time of the event" },
  { value: 15, label: "15 minutes before" },
  { value: 30, label: "30 minutes before" },
  { value: 60, label: "1 hour before" },
  { value: 120, label: "2 hours before" },
  { value: 1440, label: "1 day before" },
  { value: 2880, label: "2 days before" },
  { value: 4320, label: "3 days before" },
];
