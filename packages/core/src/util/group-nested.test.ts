import { describe, expect, it } from "vitest";
import { groupNested, flattenNested, nestedDepth, type NestedNode } from "./group-nested";

type Recall = { id: string; kind: string; status: string | null };
const r = (id: string, kind: string, status: string | null): Recall => ({ id, kind, status });

const byKind = { keyOf: (x: Recall) => x.kind };
const byStatus = { keyOf: (x: Recall) => x.status };

/** A readable shape: groups as "key(count)[children]", items as their id. */
function shape<T extends { id: string }>(nodes: Array<NestedNode<T>>): string {
  return nodes
    .map((n) => (n.kind === "item" ? n.item.id : `${n.key}(${n.count})[${shape(n.children)}]`))
    .join(" ");
}

describe("groupNested", () => {
  it("builds the two-level structure Don described", () => {
    const items = [
      r("a", "recall", "needs_vin"), r("b", "recall", "needs_vin"),
      r("c", "recall", "open"),
      r("d", "recall", "repaired"),
    ];
    const nodes = groupNested(items, [byStatus]);
    expect(shape(nodes)).toBe("needs_vin(2)[a b] open(1)[c] repaired(1)[d]");
    expect(nestedDepth(nodes)).toBe(1);
  });

  /**
   * The rule that stops the structure becoming ceremony, and the one Don was explicit about: subgroup by
   * status ONLY when there is more than one status.
   */
  it("SKIPS a level that would produce a single group", () => {
    const items = [r("a", "recall", "open"), r("b", "recall", "open"), r("c", "recall", "open")];
    const nodes = groupNested(items, [byStatus]);
    // Not "open(3)[a b c]" — a tap that tells the user nothing they did not already know.
    expect(shape(nodes)).toBe("a b c");
    expect(nestedDepth(nodes)).toBe(0);
  });

  it("nests kind then status, and skips the status level only where it is redundant", () => {
    const items = [
      r("r1", "recall", "open"), r("r2", "recall", "needs_vin"),
      r("m1", "maintenance", "due"), r("m2", "maintenance", "due"),
    ];
    const nodes = groupNested(items, [byKind, byStatus]);
    // Recalls have two statuses, so they subdivide. Maintenance has one, so it does not.
    expect(shape(nodes)).toBe("recall(2)[open(1)[r1] needs_vin(1)[r2]] maintenance(2)[m1 m2]");
  });

  it("keeps descending after a skipped level, rather than giving up and going flat", () => {
    // Every item shares a kind, so the kind level is skipped — but status still subdivides beneath it.
    const items = [r("a", "recall", "open"), r("b", "recall", "repaired")];
    expect(shape(groupNested(items, [byKind, byStatus]))).toBe("open(1)[a] repaired(1)[b]");
  });

  it("is the search/Ask rule at one level: one item, and one category, both stay plain", () => {
    expect(shape(groupNested([r("only", "purchase", null)], [byKind]))).toBe("only");
    const oneCategory = [r("a", "purchase", null), r("b", "purchase", null), r("c", "purchase", null)];
    expect(shape(groupNested(oneCategory, [byKind]))).toBe("a b c");
    const several = [r("a", "purchase", null), r("b", "document", null)];
    expect(shape(groupNested(several, [byKind]))).toBe("purchase(1)[a] document(1)[b]");
  });

  it("orders groups by first appearance, so the caller's ranking decides which leads", () => {
    const items = [r("d1", "document", null), r("p1", "purchase", null), r("p2", "purchase", null), r("p3", "purchase", null)];
    // "document" matched first and leads, even though "purchase" has more members.
    expect(shape(groupNested(items, [byKind]))).toBe("document(1)[d1] purchase(3)[p1 p2 p3]");
  });

  it("shows keyless items plainly instead of filing them somewhere they do not belong", () => {
    const items = [r("a", "recall", "open"), r("b", "recall", "repaired"), r("c", "recall", null)];
    expect(shape(groupNested(items, [byStatus]))).toBe("open(1)[a] repaired(1)[b] c");
  });

  it("loses nothing — flattening returns every item, in order", () => {
    const items = [
      r("a", "recall", "open"), r("b", "recall", "needs_vin"),
      r("c", "maintenance", "due"), r("d", "maintenance", null),
    ];
    expect(flattenNested(groupNested(items, [byKind, byStatus]))).toEqual(items);
  });

  it("a group's members are every item beneath it, however deep", () => {
    const items = [r("a", "recall", "open"), r("b", "recall", "repaired")];
    const nodes = groupNested(items, [{ keyOf: (x: Recall) => x.kind, minGroups: 1 }, byStatus]);
    const recall = nodes[0]!;
    expect(recall.kind).toBe("group");
    if (recall.kind === "group") {
      expect(recall.count).toBe(2);
      expect(recall.members).toEqual(items);
      expect(shape(recall.children)).toBe("open(1)[a] repaired(1)[b]");
    }
  });

  it("handles empty, and no keys at all", () => {
    expect(groupNested([], [byKind])).toEqual([]);
    expect(shape(groupNested([r("a", "x", null)], []))).toBe("a");
  });

  it("scales to the real shape without inventing structure", () => {
    // 55 recalls across three statuses, the account that started this.
    const items: Recall[] = [];
    for (let i = 0; i < 41; i++) items.push(r(`v${i}`, "recall", "needs_vin"));
    for (let i = 0; i < 11; i++) items.push(r(`o${i}`, "recall", "open"));
    for (let i = 0; i < 3; i++) items.push(r(`p${i}`, "recall", "repaired"));
    const nodes = groupNested(items, [byStatus]);
    expect(nodes).toHaveLength(3);
    expect(nodes.map((n) => (n.kind === "group" ? n.count : 0))).toEqual([41, 11, 3]);
    expect(flattenNested(nodes)).toHaveLength(55);
  });
});
