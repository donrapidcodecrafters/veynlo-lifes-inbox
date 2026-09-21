import { describe, expect, it } from "vitest";
import { collapseRuns, groupResultSet, longestRun, DEFAULT_COLLAPSE_THRESHOLD, type CollapsedEntry } from "./collapse-runs";

type Item = { id: string; kind: string | null };
const item = (id: string, kind: string | null): Item => ({ id, kind });
const keyOf = (i: Item) => i.kind;
const collapse = (items: Item[], threshold?: number) => collapseRuns(items, { keyOf, threshold });
const shape = (entries: Array<CollapsedEntry<Item>>) =>
  entries.map((e) => (e.kind === "group" ? `${e.key}x${e.count}` : e.item.id));

describe("collapseRuns", () => {
  it("folds a run at the threshold and leaves a shorter one alone", () => {
    const entries = collapse([item("a", "recall"), item("b", "recall"), item("c", "recall"), item("d", "bill"), item("e", "bill")]);
    expect(shape(entries)).toEqual(["recallx3", "d", "e"]);
  });

  it("is exactly at the boundary, not near it", () => {
    expect(shape(collapse([item("a", "x"), item("b", "x")]))).toEqual(["a", "b"]);
    expect(shape(collapse([item("a", "x"), item("b", "x"), item("c", "x")]))).toEqual(["xx3"]);
  });

  /**
   * The guarantee, asserted directly rather than inferred from the mechanism. This is the whole point of
   * the feature: at threshold 3, no kind can occupy more than two consecutive rows, so nothing can ever
   * build into the wall DEF-104 found on Home.
   */
  it("GUARANTEES no more than threshold-1 of one kind in a row, on an adversarial list", () => {
    const kinds = ["recall", "bill", "event", "return", "trial"];
    const items: Item[] = [];
    // 55 of one kind, then alternating pairs, then another long run — the shape a priority sort produces.
    for (let i = 0; i < 55; i++) items.push(item(`r${i}`, "recall"));
    for (let i = 0; i < 20; i++) items.push(item(`m${i}`, kinds[i % kinds.length]!));
    for (let i = 0; i < 9; i++) items.push(item(`b${i}`, "bill"));
    const entries = collapse(items);
    expect(longestRun(entries, keyOf)).toBeLessThanOrEqual(DEFAULT_COLLAPSE_THRESHOLD - 1);
  });

  it("never reorders — a collapsed list is the same list with stretches folded", () => {
    const items = [item("a", "x"), item("b", "y"), item("c", "x"), item("d", "x"), item("e", "x")];
    const entries = collapse(items);
    // "x" appears both before and after "b". Grouping by KEY would pull them together and change the
    // order the priority sort chose; grouping by adjacency must not.
    expect(shape(entries)).toEqual(["a", "b", "xx3"]);
  });

  it("flattens back to exactly the input, in order — nothing is lost or duplicated", () => {
    const items = [item("a", "x"), item("b", "x"), item("c", "x"), item("d", null), item("e", "y"), item("f", "y")];
    const flat = collapse(items).flatMap((e) => (e.kind === "group" ? e.members : [e.item]));
    expect(flat).toEqual(items);
  });

  it("never groups keyless items, even when several sit together", () => {
    // "these three things have nothing in common" is not a group a user would recognise.
    const entries = collapse([item("a", null), item("b", null), item("c", null)]);
    expect(shape(entries)).toEqual(["a", "b", "c"]);
  });

  it("treats an empty-string key the same as no key", () => {
    expect(shape(collapse([item("a", ""), item("b", ""), item("c", "")]))).toEqual(["a", "b", "c"]);
  });

  it("represents a group by its FIRST member, which the caller has already sorted as the most important", () => {
    const entries = collapse([item("first", "x"), item("second", "x"), item("third", "x")]);
    const group = entries[0]!;
    expect(group.kind).toBe("group");
    if (group.kind === "group") {
      expect(group.representative.id).toBe("first");
      // A group advertising its least urgent member would misdescribe what it contains.
      expect(group.members.map((m) => m.id)).toEqual(["first", "second", "third"]);
    }
  });

  it("honours a custom representative", () => {
    const entries = collapseRuns([item("a", "x"), item("b", "x"), item("c", "x")], {
      keyOf,
      representativeOf: (members) => members[members.length - 1]!,
    });
    expect(entries[0]!.kind === "group" && entries[0]!.representative.id).toBe("c");
  });

  it("handles an empty list and a single item", () => {
    expect(collapse([])).toEqual([]);
    expect(shape(collapse([item("only", "x")]))).toEqual(["only"]);
  });

  it("folds several separate runs of the same kind independently", () => {
    const items = [
      item("a", "x"), item("b", "x"), item("c", "x"),
      item("gap", "y"),
      item("d", "x"), item("e", "x"), item("f", "x"),
    ];
    expect(shape(collapse(items))).toEqual(["xx3", "gap", "xx3"]);
  });
});

describe("groupResultSet — search and Ask", () => {
  const group = (items: Item[]) => groupResultSet(items, keyOf);
  const shapeR = (entries: ReturnType<typeof group>) =>
    entries.map((e) => (e.kind === "group" ? `${e.key}x${e.count}` : e.item.id));

  it("a single result is just the item, never a group to open", () => {
    expect(shapeR(group([item("only", "purchase")]))).toEqual(["only"]);
  });

  it("several results in ONE category are not grouped — the category is already obvious", () => {
    const entries = group([item("a", "purchase"), item("b", "purchase"), item("c", "purchase")]);
    expect(shapeR(entries)).toEqual(["a", "b", "c"]);
    // Note this is three of a kind and would have collapsed under the FEED rule. Different surface,
    // different question: a feed asks "is this a wall", a result set asks "what kinds matched".
    expect(shape(collapse([item("a", "purchase"), item("b", "purchase"), item("c", "purchase")]))).toEqual(["purchasex3"]);
  });

  it("several results across SEVERAL categories are grouped, and every group starts collapsed", () => {
    const entries = group([item("a", "purchase"), item("b", "document"), item("c", "purchase"), item("d", "event")]);
    expect(shapeR(entries)).toEqual(["purchasex2", "documentx1", "eventx1"]);
    for (const e of entries) if (e.kind === "group") expect(e.startsCollapsed).toBe(true);
  });

  it("groups come back in order of their best-ranked member, so relevance survives grouping", () => {
    // "document" matched first, so it leads, even though "purchase" has more members.
    const entries = group([item("d1", "document"), item("p1", "purchase"), item("p2", "purchase"), item("p3", "purchase")]);
    expect(shapeR(entries)).toEqual(["documentx1", "purchasex3"]);
  });

  it("groups of one are still groups when several categories matched", () => {
    // The point of this case is telling the user WHICH kinds matched; a category with one hit is part of
    // that answer and dropping it out of the grouping would make the set look inconsistent.
    const entries = group([item("a", "purchase"), item("b", "document")]);
    expect(shapeR(entries)).toEqual(["purchasex1", "documentx1"]);
  });

  it("keeps uncategorised results visible rather than filing them somewhere they do not belong", () => {
    const entries = group([item("a", "purchase"), item("b", "document"), item("c", null)]);
    expect(shapeR(entries)).toEqual(["purchasex1", "documentx1", "c"]);
  });

  it("loses nothing: flattening returns every input item", () => {
    const items = [item("a", "purchase"), item("b", "document"), item("c", "purchase"), item("d", null)];
    const flat = group(items).flatMap((e) => (e.kind === "group" ? e.members : [e.item]));
    expect(flat.length).toBe(items.length);
    for (const i of items) expect(flat).toContain(i);
  });

  it("handles empty", () => {
    expect(group([])).toEqual([]);
  });
});
