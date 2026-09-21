import { groupNested } from "./group-nested";

/**
 * Collapse runs of same-kind items into one expandable group.
 *
 * Built because Home became unusable at realistic volume (DEF-104): 125 unresolved attention items, 55 of
 * them vehicle recalls, all in the same urgency tier, so they sorted into one unbroken wall and pushed
 * today's actual tasks eight swipes down the screen. But the problem is not Home's — it is any list where
 * one kind of thing can arrive in bulk, and this app has several. So the rule lives here, in one tested
 * place, rather than as a special case on one screen.
 *
 * The rule: **a run of `threshold` or more adjacent items sharing a key becomes a single group.** Adjacency
 * matters and is not an implementation detail — collapsing by key alone would reorder the list, and the
 * ordering is the product of a deliberate priority sort that this must not overrule. Only what is already
 * next to each other is folded together, so the list a user sees is the same list in the same order, with
 * its repetitive stretches folded.
 *
 * At a threshold of 3 no kind can ever occupy more than two consecutive rows anywhere. That is the property
 * worth holding onto, and it is what the tests assert — not the mechanism, which could change.
 */

/** A run that was folded, or a single item that was not. */
export type CollapsedEntry<T> =
  | { kind: "item"; item: T }
  | { kind: "group"; key: string; count: number; representative: T; members: T[] };

export interface CollapseOptions<T> {
  /** What makes two items "the same kind". Items with a null key are never grouped. */
  keyOf: (item: T) => string | null | undefined;
  /** Minimum run length to fold. Below this, items are emitted individually. */
  threshold?: number;
  /**
   * Which member represents the group. Defaults to the first, which — given the caller has already sorted
   * by priority — is the most important one in the run, and therefore the one whose urgency and due date
   * the collapsed card should show. A group that advertised its LEAST urgent member would be actively
   * misleading about what it contains.
   */
  representativeOf?: (members: T[]) => T;
}

export const DEFAULT_COLLAPSE_THRESHOLD = 3;

export function collapseRuns<T>(items: readonly T[], opts: CollapseOptions<T>): Array<CollapsedEntry<T>> {
  const threshold = opts.threshold ?? DEFAULT_COLLAPSE_THRESHOLD;
  const pick = opts.representativeOf ?? ((members: T[]) => members[0]!);
  const out: Array<CollapsedEntry<T>> = [];

  let i = 0;
  while (i < items.length) {
    const key = opts.keyOf(items[i]!);
    if (key == null || key === "") {
      // No key means no kind, so nothing to group it with. Deliberately not grouped with other keyless
      // items: "these three things have nothing in common" is not a group a user would recognise.
      out.push({ kind: "item", item: items[i]! });
      i++;
      continue;
    }

    let j = i + 1;
    while (j < items.length && opts.keyOf(items[j]!) === key) j++;
    const run = items.slice(i, j) as T[];

    if (run.length >= threshold) {
      out.push({ kind: "group", key, count: run.length, representative: pick(run), members: run });
    } else {
      for (const item of run) out.push({ kind: "item", item });
    }
    i = j;
  }

  return out;
}

/**
 * The property the whole thing exists for: how many rows of one kind can a user meet in a row?
 *
 * Exported so tests can assert the guarantee directly rather than inferring it from the mechanism, and so a
 * caller with an unusual key function can check its own result.
 */
export function longestRun<T>(entries: Array<CollapsedEntry<T>>, keyOf: (item: T) => string | null | undefined): number {
  let longest = 0;
  let current = 0;
  let currentKey: string | null = null;
  for (const e of entries) {
    if (e.kind === "group") {
      current = 0;
      currentKey = null;
      continue;
    }
    const key = keyOf(e.item) ?? null;
    if (key !== null && key === currentKey) current++;
    else {
      currentKey = key;
      current = 1;
    }
    if (current > longest) longest = current;
  }
  return longest;
}

/**
 * The rule for a RESULT SET — search, Ask — which is deliberately not the rule for a ranked feed.
 *
 * Don's specification, and it is about what the result set MEANS rather than how long it is:
 *
 *   one result                       -> just the item. A lone answer inside a group you must open first is
 *                                       an obstacle standing where the answer should be.
 *   several, all one category        -> no grouping. The category is already obvious from the results
 *                                       themselves, so a single group wrapping all of them says nothing and
 *                                       costs a tap.
 *   several, several categories      -> group by category, every group starting COLLAPSED. This is the case
 *                                       where grouping earns its keep: the user can see at a glance which
 *                                       kinds of thing matched and how many of each, then open the one they
 *                                       meant, instead of scrolling a mixed list to find out what is in it.
 *
 * Grouping is by key here, not by adjacency as `collapseRuns` does, because a result set has no meaningful
 * running order to protect — but relevance is not discarded either: groups come back in the order of their
 * best-ranked member, so the most relevant kind of thing is still first.
 */
export type ResultGroup<T> =
  | { kind: "item"; item: T }
  | { kind: "group"; key: string; count: number; members: T[]; startsCollapsed: true };

export function groupResultSet<T>(
  items: readonly T[],
  keyOf: (item: T) => string | null | undefined,
): Array<ResultGroup<T>> {
  // One key, one level. `groupNested` already skips a level that would yield a single group, which IS the
  // "one result" and "one category" rules — they were never separate behaviours, and keeping a second
  // implementation of them would have meant two things to drift apart.
  return groupNested(items, [{ keyOf }]).map((n) =>
    n.kind === "item"
      ? { kind: "item", item: n.item }
      : { kind: "group", key: n.key, count: n.count, members: n.members, startsCollapsed: true },
  );
}
