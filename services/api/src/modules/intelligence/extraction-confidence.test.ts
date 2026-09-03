import { describe, expect, it } from "vitest";
import { computeExtractionConfidence } from "./extraction-confidence";

describe("computeExtractionConfidence", () => {
  it("scores a fully-populated extraction near the top of the range", () => {
    const score = computeExtractionConfidence({
      billerName: "Pacific Gas & Electric",
      amountDueMinorUnits: 12_345,
      currency: "USD",
      dueDate: { iso_date: "2026-09-15", approximate_text: null },
      autopayMentioned: false,
      accountLabel: "Acct #1234",
      confidenceNotes: "Clearly stated in the email.",
    });
    expect(score).toBeCloseTo(0.95, 5);
  });

  it("scores an extraction with everything null at the midpoint, not zero", () => {
    const score = computeExtractionConfidence({
      billerName: null,
      amountDueMinorUnits: null,
      currency: "USD", // has a schema default, so it's non-null even on a mostly-empty extraction
      dueDate: null,
      autopayMentioned: null,
      accountLabel: null,
      confidenceNotes: "Nothing concrete stated.",
    });
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(0.7);
  });

  it("never scores lower than 0.5 or higher than 0.95 regardless of field count", () => {
    expect(computeExtractionConfidence({})).toBe(0.5);
    expect(computeExtractionConfidence({ a: "x", b: "y", confidenceNotes: "n/a" })).toBeLessThanOrEqual(0.95);
  });

  it("ignores confidenceNotes itself as a completeness signal", () => {
    const withNotes = computeExtractionConfidence({ a: null, confidenceNotes: "a very long explanation that says nothing was found" });
    const withoutNotes = computeExtractionConfidence({ a: null });
    expect(withNotes).toBe(withoutNotes);
  });

  it("treats an empty array or empty string as absent, not present", () => {
    const score = computeExtractionConfidence({ lineItems: [], merchantName: "", orderNumber: "ORD-1" });
    // Only orderNumber counts as present: 1/3 complete.
    expect(score).toBeCloseTo(0.5 + 0.45 * (1 / 3), 5);
  });
});
