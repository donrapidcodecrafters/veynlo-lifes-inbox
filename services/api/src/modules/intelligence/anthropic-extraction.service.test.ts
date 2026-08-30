import { describe, expect, it } from "vitest";
import { calibrateConfidence, estimateCostMinorUnits } from "./anthropic-extraction.service";

describe("calibrateConfidence", () => {
  it("scores a complete extraction with no flagged uncertainty near the top of the range", () => {
    const score = calibrateConfidence({
      merchantName: "Acme Co",
      orderNumber: "12345",
      totalAmountMinorUnits: 4200,
      currency: "USD",
      confidenceNotes: "",
    });
    expect(score).toBeGreaterThanOrEqual(0.85); // must actually clear the "high" band threshold
  });

  it("penalizes an extraction with several missing fields", () => {
    const complete = calibrateConfidence({ a: "x", b: "y", c: "z", confidenceNotes: "" });
    const halfMissing = calibrateConfidence({ a: "x", b: null, c: null, confidenceNotes: "" });
    expect(halfMissing).toBeLessThan(complete);
  });

  it("penalizes an extraction where the model explicitly flagged ambiguity", () => {
    const clean = calibrateConfidence({ a: "x", confidenceNotes: "" });
    const flagged = calibrateConfidence({ a: "x", confidenceNotes: "The date was smudged in the photo, guessing based on context." });
    expect(flagged).toBeLessThan(clean);
  });

  it("never returns a score that can reach the 'high' band when both signals are bad", () => {
    const score = calibrateConfidence({
      a: null,
      b: null,
      c: null,
      confidenceNotes: "Almost everything here was illegible.",
    });
    expect(score).toBeLessThan(0.55); // must actually land in "approximate", not just "needs_review"
  });

  it("excludes confidenceNotes itself from the null-ratio calculation", () => {
    // A single real field, present, with an empty (non-null, just empty-string) confidenceNotes should
    // score as a clean 1-of-1 complete extraction, not be dragged down by confidenceNotes being "just a string".
    const score = calibrateConfidence({ onlyField: "present", confidenceNotes: "" });
    expect(score).toBeGreaterThanOrEqual(0.9);
  });

  it("stays within [0.4, 0.97] regardless of input shape", () => {
    expect(calibrateConfidence({})).toBeGreaterThanOrEqual(0.4);
    expect(calibrateConfidence({})).toBeLessThanOrEqual(0.97);
    expect(calibrateConfidence(null)).toBe(0.75);
    expect(calibrateConfidence("not an object")).toBe(0.75);
  });
});

describe("estimateCostMinorUnits", () => {
  it("computes a real cost in cents from token counts for a known model", () => {
    // 1M input tokens + 1M output tokens against the Haiku price row (100 + 500 cents).
    expect(estimateCostMinorUnits("claude-haiku-4-5-20251001", 1_000_000, 1_000_000)).toBe(600);
  });

  it("scales linearly with token count", () => {
    expect(estimateCostMinorUnits("claude-sonnet-5", 500_000, 0)).toBe(150);
    expect(estimateCostMinorUnits("claude-sonnet-5", 0, 500_000)).toBe(750);
  });

  it("returns null for an unpriced model rather than silently guessing", () => {
    expect(estimateCostMinorUnits("some-future-model", 1000, 1000)).toBeNull();
  });
});
