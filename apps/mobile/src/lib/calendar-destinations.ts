/** CAL-001/CAL-002 shared constants — mirrors apps/web's identical file (apps/web/src/lib/calendar-destinations.ts). */
export const PROVIDER_LABEL: Record<string, string> = {
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
};

export const REMINDER_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "At the time" },
  { value: 15, label: "15 min before" },
  { value: 30, label: "30 min before" },
  { value: 60, label: "1 hour before" },
  { value: 120, label: "2 hours before" },
  { value: 1440, label: "1 day before" },
  { value: 2880, label: "2 days before" },
  { value: 4320, label: "3 days before" },
];
