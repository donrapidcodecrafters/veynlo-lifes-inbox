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
