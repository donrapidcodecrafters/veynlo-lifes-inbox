import { describe, expect, it } from "vitest";
import { rankByRelevance, scoreRelevance } from "./relevance-ranking";

/** The premise the MemoriesService.search fix rests on, checked directly. */
describe("relevance ranking: rank is not filter", () => {
  const rows = [
    { text: "Ski lodge in Vermont with a hot tub" },
    { text: "Replace the kitchen tap washer" },
    { text: "Anniversary dinner reservation ideas" },
  ];
  const getText = (r: { text: string }) => r.text;

  it("scores a non-matching query at exactly 0 for every row", () => {
    for (const r of rows) expect(scoreRelevance("zzznonsensequery12345", r.text)).toBe(0);
  });

  it("rankByRelevance still returns every one of those zero-scoring rows — this was the bug", () => {
    expect(rankByRelevance("zzznonsensequery12345", rows, getText, 30)).toHaveLength(3);
  });

  it("and returns them in arrival order, so two different nonsense queries look byte-identical", () => {
    const a = rankByRelevance("zzznonsensequery12345", rows, getText, 30).map(getText);
    const b = rankByRelevance("anotherquerythatmatchesnothing", rows, getText, 30).map(getText);
    expect(a).toEqual(b);
    expect(a).toEqual(rows.map(getText));
  });

  it("an explicit score > 0 filter — what search() now does — returns nothing for the same query", () => {
    const filtered = rows.filter((r) => scoreRelevance("zzznonsensequery12345", r.text) > 0);
    expect(filtered).toEqual([]);
  });

  it("while a real term still matches, and only the row that contains it", () => {
    const filtered = rows.filter((r) => scoreRelevance("lodge", r.text) > 0);
    expect(filtered.map(getText)).toEqual(["Ski lodge in Vermont with a hot tub"]);
  });
});
