import { z } from "zod";

/**
 * Time handling per spec §"Time and Date Handling": store an absolute UTC
 * instant when one truly exists, but never collapse an all-day/floating/
 * approximate date into a fabricated instant. `TemporalValue` makes the
 * precision explicit so the UI and rules engine can't silently assume
 * more certainty than the evidence supports.
 */
export const TemporalPrecisionSchema = z.enum([
  "instant", // exact moment known, e.g. a confirmed appointment time
  "date", // a specific calendar date, no time-of-day (all-day event, due date)
  "month", // "sometime in November 2027" — never round to a fabricated day
  "approximate", // "next month", "in a few weeks" — explicitly uncertain
  "unknown", // evidence exists but no date could be extracted — never guess
]);
export type TemporalPrecision = z.infer<typeof TemporalPrecisionSchema>;

export const TemporalValueSchema = z.object({
  precision: TemporalPrecisionSchema,
  /** ISO-8601 instant (UTC) — only present when precision === "instant". */
  instantUtc: z.string().datetime().nullable(),
  /** ISO-8601 date (YYYY-MM-DD) — present for "date" and "month" (first-of-month). */
  date: z.string().nullable(),
  /** IANA timezone the value should be interpreted/displayed in. */
  timezone: z.string().nullable(),
  /** Free-text as originally evidenced, kept for audit ("early next year"). */
  sourceText: z.string().nullable(),
});
export type TemporalValue = z.infer<typeof TemporalValueSchema>;

export function unknownTemporal(sourceText?: string): TemporalValue {
  return { precision: "unknown", instantUtc: null, date: null, timezone: null, sourceText: sourceText ?? null };
}

export function instantTemporal(instantUtc: string, timezone: string): TemporalValue {
  return { precision: "instant", instantUtc, date: null, timezone, sourceText: null };
}
