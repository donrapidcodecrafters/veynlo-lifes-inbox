import { describe, expect, it } from "vitest";
import { toTemporalValue, temporalToSortDate } from "./temporal.util";

describe("toTemporalValue", () => {
  it("never fabricates a date when nothing was extracted", () => {
    const value = toTemporalValue(null);
    expect(value.precision).toBe("unknown");
    expect(value.date).toBeNull();
  });

  it("never fabricates a date when both fields are null", () => {
    const value = toTemporalValue({ iso_date: null, approximate_text: null });
    expect(value.precision).toBe("unknown");
  });

  it("prefers an exact ISO date when present", () => {
    const value = toTemporalValue({ iso_date: "2027-11-18", approximate_text: null }, "America/Chicago");
    expect(value).toEqual({
      precision: "date",
      instantUtc: null,
      date: "2027-11-18",
      timezone: "America/Chicago",
      sourceText: null,
    });
  });

  it("preserves an approximate phrase as explicitly uncertain, not a guessed date", () => {
    const value = toTemporalValue({ iso_date: null, approximate_text: "early next month" });
    expect(value.precision).toBe("approximate");
    expect(value.date).toBeNull();
    expect(value.sourceText).toBe("early next month");
  });
});

describe("temporalToSortDate", () => {
  it("derives a sortable Date from a date-precision value", () => {
    const sort = temporalToSortDate({ precision: "date", instantUtc: null, date: "2027-01-15", timezone: null, sourceText: null });
    expect(sort?.toISOString().startsWith("2027-01-15")).toBe(true);
  });

  it("returns null for unknown/approximate precision rather than a fabricated sort key", () => {
    expect(temporalToSortDate({ precision: "unknown", instantUtc: null, date: null, timezone: null, sourceText: null })).toBeNull();
    expect(
      temporalToSortDate({ precision: "approximate", instantUtc: null, date: null, timezone: null, sourceText: "soon" }),
    ).toBeNull();
  });
});
