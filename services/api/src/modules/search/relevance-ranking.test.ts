import { describe, expect, it } from "vitest";
import { scoreRelevance, rankByRelevance } from "./relevance-ranking";

describe("scoreRelevance", () => {
  it("scores a fully-matching candidate at 1", () => {
    expect(scoreRelevance("when is my dyson warranty due", "Warranty for Dyson V15, due next month")).toBeCloseTo(1, 5);
  });

  it("scores an unrelated candidate at 0", () => {
    expect(scoreRelevance("when is my dyson warranty due", "Dentist appointment with Dr. Patel")).toBe(0);
  });

  it("scores a partial match proportionally to matched question terms", () => {
    // "netflix" and "renewal" are the two meaningful words; only one appears.
    const score = scoreRelevance("when is my netflix renewal", "Netflix subscription active");
    expect(score).toBeCloseTo(0.5, 5);
  });

  it("ignores stop words and case when matching", () => {
    expect(scoreRelevance("What is the total for my Best Buy order?", "BEST BUY order total: $1299")).toBeGreaterThan(0.5);
  });

  it("returns 0 for an empty question", () => {
    expect(scoreRelevance("", "anything at all")).toBe(0);
  });
});

describe("rankByRelevance", () => {
  it("puts the most relevant item first regardless of original order", () => {
    const items = [
      { id: "a", text: "Dentist appointment" },
      { id: "b", text: "Dyson vacuum warranty expires next year" },
      { id: "c", text: "Flight confirmation to Denver" },
    ];
    const ranked = rankByRelevance("when does my dyson warranty expire", items, (i) => i.text, 3);
    expect(ranked[0]?.id).toBe("b");
  });

  it("truncates to the given limit", () => {
    const items = Array.from({ length: 100 }, (_, i) => ({ id: String(i), text: `item ${i}` }));
    const ranked = rankByRelevance("item", items, (i) => i.text, 10);
    expect(ranked).toHaveLength(10);
  });

  it("keeps stable original order among equally-scored (e.g. all-zero) items", () => {
    const items = [{ id: "x", text: "alpha" }, { id: "y", text: "beta" }, { id: "z", text: "gamma" }];
    const ranked = rankByRelevance("unrelated question with no overlap", items, (i) => i.text, 3);
    expect(ranked.map((i) => i.id)).toEqual(["x", "y", "z"]);
  });
});
