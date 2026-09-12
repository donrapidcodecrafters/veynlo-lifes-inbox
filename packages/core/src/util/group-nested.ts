/**
 * Nested, collapsible grouping — the shape Don asked for.
 *
 *   Recalls (55)                      collapsed
 *     └ Needs your VIN (41)           collapsed
 *         └ record, record, …         inline, each tappable through to its own screen
 *     └ Open (11)                     collapsed
 *     └ Repaired (3)                  collapsed
 *
 * with one rule that does most of the work:
 *
 *   **A grouping level that would produce only ONE group is skipped entirely.**
 *
 * That is what stops the structure becoming ceremony. If all 55 recalls share a status, splitting them by
 * status produces a single group called "Open" sitting inside a group called "Recalls" — a tap that tells
 * the user nothing they did not already know. Skipping the level drops them straight to the records.
 *
 * The same rule, applied at the top level, is exactly the search/Ask behaviour Don specified: one result is
 * just the item, several results in one category are just the items, several categories become collapsed
 * groups. `groupResultSet` is now literally a one-key call into this — they were the same idea from the
 * start, and keeping two implementations of it would have meant two behaviours to drift apart.
 *
 * Grouping is by KEY, not by adjacency. That is right here and wrong for a ranked feed, which is why
 * `collapseRuns` in ./collapse-runs.ts stays separate: a feed has a priority order that grouping must not
 * overrule, while a section of recalls has no meaningful running order to protect.
 */

export type NestedNode<T> =
  | { kind: "item"; item: T }
  | { kind: "group"; key: string; count: number; children: Array<NestedNode<T>>; members: T[] };

export interface NestedKey<T> {
  /** What to group by at this level. Items returning null are never grouped at this level. */
  keyOf: (item: T) => string | null | undefined;
  /**
   * Minimum distinct groups for this level to be worth having. Below it, the level is skipped and the next
   * key is tried. Two is the meaningful default: one group is never worth a tap.
   */
  minGroups?: number;
}

/**
 * Group `items` by each key in turn, skipping any level that would yield fewer than `minGroups` groups.
 *
 * Order within a level follows the order of first appearance, so whatever ranking the caller applied — a
 * relevance sort, a due-date sort — still decides which group leads.
 */
export function groupNested<T>(items: readonly T[], keys: ReadonlyArray<NestedKey<T>>): Array<NestedNode<T>> {
  if (items.length === 0) return [];
  if (keys.length === 0) return items.map((item) => ({ kind: "item", item }));

  const [level, ...rest] = keys;
  const minGroups = level!.minGroups ?? 2;

  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  const keyless: T[] = [];

  for (const item of items) {
    const key = level!.keyOf(item);
    if (key == null || key === "") { keyless.push(item); continue; }
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key)!.push(item);
  }

  // Not enough distinct groups for this level to say anything — skip it and try the next key. Recursing
  // with `rest` rather than returning items flat is what makes a deep structure collapse gracefully: a
  // section whose items all share a status still subdivides by whatever comes after status.
  if (byKey.size < minGroups) return groupNested(items, rest);

  const out: Array<NestedNode<T>> = order.map((key) => {
    const members = byKey.get(key)!;
    return {
      kind: "group" as const,
      key,
      count: members.length,
      members,
      children: groupNested(members, rest),
    };
  });
  // Anything with no key at this level cannot be filed, and burying it in a group it does not belong to
  // would be worse than showing it plainly alongside the groups.
  for (const item of keyless) out.push({ kind: "item", item });
  return out;
}

/** Every item under a node, in order — what a caller needs to render a fully-expanded group. */
export function flattenNested<T>(nodes: ReadonlyArray<NestedNode<T>>): T[] {
  const out: T[] = [];
  for (const n of nodes) {
    if (n.kind === "item") out.push(n.item);
    else out.push(...flattenNested(n.children));
  }
  return out;
}

/** How deep the grouping actually went — 0 when every level was skipped and it is a plain list. */
export function nestedDepth<T>(nodes: ReadonlyArray<NestedNode<T>>): number {
  let deepest = 0;
  for (const n of nodes) {
    if (n.kind !== "group") continue;
    deepest = Math.max(deepest, 1 + nestedDepth(n.children));
  }
  return deepest;
}
