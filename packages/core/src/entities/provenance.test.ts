import { describe, expect, it } from "vitest";
import { confidenceToBand } from "./provenance";

describe("confidenceToBand", () => {
  const thresholds = { reviewThreshold: 0.55, highThreshold: 0.85 };

  it("never reports 'high' below the domain's high threshold", () => {
    expect(confidenceToBand(0.84, thresholds)).not.toBe("high");
    expect(confidenceToBand(0.85, thresholds)).toBe("high");
  });

  it("falls to needs-review band between thresholds", () => {
    expect(confidenceToBand(0.6, thresholds)).toBe("needs_review");
  });

  it("treats anything below the review threshold as merely approximate, never fabricated certainty", () => {
    expect(confidenceToBand(0.1, thresholds)).toBe("approximate");
  });
});
