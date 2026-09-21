import { describe, expect, it } from "vitest";
import {
  findTokenTaskProvider,
  listTokenTaskProviders,
  normalizeAsana,
  normalizeTodoist,
  normalizeTrello,
  toDueDate,
} from "./token-task-providers";

/**
 * What the three task providers return, and what this app is willing to believe about it.
 *
 * The normalizers are where a wrong due date gets made. A task shown as due on the wrong day is worse
 * than a task with no due date at all: the user plans around it and misses the real one. So the bar here
 * is that anything not unambiguously a date becomes null, and that a provider's own completion flag is
 * read rather than inferred.
 */
describe("task provider registry", () => {
  it("lists only providers that can actually be connected", () => {
    const keys = listTokenTaskProviders().map((p) => p.key);
    expect(keys).toEqual(["todoist", "trello", "asana"]);
    // TickTick, Any.do and Notion are deliberately absent — see the module's own doc comment.
    expect(keys).not.toContain("ticktick");
    expect(keys).not.toContain("notion");
  });

  it("tells the user where to get each credential", () => {
    for (const provider of listTokenTaskProviders()) {
      expect(provider.credentialHint.length).toBeGreaterThan(20);
      expect(provider.credentialUrl).toMatch(/^https:\/\//);
      expect(provider.apiBase).toMatch(/^https:\/\//);
    }
  });

  it("knows that only Trello needs a second secret", () => {
    expect(findTokenTaskProvider("trello")?.requiresApiKey).toBe(true);
    expect(findTokenTaskProvider("todoist")?.requiresApiKey).toBe(false);
    expect(findTokenTaskProvider("asana")?.requiresApiKey).toBe(false);
  });

  it("does not resolve a provider it does not support", () => {
    expect(findTokenTaskProvider("ticktick")).toBeUndefined();
    expect(findTokenTaskProvider("")).toBeUndefined();
  });
});

describe("due dates", () => {
  it("accepts a plain date and the date part of a timestamp", () => {
    expect(toDueDate("2026-03-14")).toBe("2026-03-14");
    expect(toDueDate("2026-03-14T17:30:00Z")).toBe("2026-03-14");
  });

  it("rejects a date that does not exist rather than storing it", () => {
    // 2025 is not a leap year. Date() would happily roll this to March 1st and show the user a due date
    // the provider never gave — a fabricated deadline is the worst possible failure for this field.
    expect(toDueDate("2025-02-30")).toBeNull();
    expect(toDueDate("2026-13-01")).toBeNull();
    expect(toDueDate("2026-02-29")).toBeNull();
  });

  it("accepts a real leap day", () => {
    expect(toDueDate("2024-02-29")).toBe("2024-02-29");
  });

  it("will not lift a date out of the middle of a sentence", () => {
    // The pattern is anchored, and that anchoring is the guard. A provider field reading "ask Sam before
    // 2026-03-14" is a note, not a deadline — treating it as one puts a due date on the wrong task and
    // the user plans around a date nobody set.
    expect(toDueDate("ask Sam before 2026-03-14")).toBeNull();
    expect(toDueDate("due 2026-03-14")).toBeNull();
  });

  it("returns null for anything that is not a date", () => {
    expect(toDueDate(null)).toBeNull();
    expect(toDueDate(undefined)).toBeNull();
    expect(toDueDate(1_700_000_000)).toBeNull();
    expect(toDueDate("tomorrow")).toBeNull();
    expect(toDueDate("14/03/2026")).toBeNull();
    expect(toDueDate({ date: "2026-03-14" })).toBeNull();
  });
});

describe("Todoist", () => {
  it("reads id, content and due date", () => {
    const [task] = normalizeTodoist([
      { id: "6789", content: "Renew passport", due: { date: "2026-03-14" }, is_completed: false },
    ]);
    expect(task).toEqual({ externalId: "6789", title: "Renew passport", dueDate: "2026-03-14", completed: false });
  });

  it("accepts a numeric id, which Todoist's older responses use", () => {
    expect(normalizeTodoist([{ id: 6789, content: "x" }])[0]?.externalId).toBe("6789");
  });

  it("falls back to the datetime when there is no plain date", () => {
    expect(normalizeTodoist([{ id: "1", content: "x", due: { datetime: "2026-03-14T09:00:00Z" } }])[0]?.dueDate).toBe("2026-03-14");
  });

  it("skips entries with no usable id instead of inventing one", () => {
    // An id is how a task is matched on the next sync. A generated one would duplicate the task forever.
    expect(normalizeTodoist([{ content: "no id" }, { id: null, content: "null id" }, { id: "2", content: "ok" }])).toHaveLength(1);
  });

  it("survives a payload that is not a list", () => {
    expect(normalizeTodoist({ error: "unauthorized" })).toEqual([]);
    expect(normalizeTodoist(null)).toEqual([]);
    expect(normalizeTodoist("")).toEqual([]);
  });

  it("gives a title to a task that has none", () => {
    expect(normalizeTodoist([{ id: "1", content: "   " }])[0]?.title).toBe("Untitled task");
  });

  it("bounds a very long title", () => {
    expect(normalizeTodoist([{ id: "1", content: "x".repeat(5000) }])[0]?.title).toHaveLength(500);
  });
});

describe("Trello", () => {
  it("reads a card's id, name and due date", () => {
    const [card] = normalizeTrello([
      { id: "5f2b", name: "Book the venue", due: "2026-05-01T12:00:00.000Z", dueComplete: false, closed: false },
    ]);
    expect(card).toEqual({ externalId: "5f2b", title: "Book the venue", dueDate: "2026-05-01", completed: false });
  });

  it("treats a card's own completion flag as completion", () => {
    expect(normalizeTrello([{ id: "a", name: "x", dueComplete: true }])[0]?.completed).toBe(true);
  });

  it("treats an archived card as done rather than as an open task", () => {
    expect(normalizeTrello([{ id: "a", name: "x", closed: true }])[0]?.completed).toBe(true);
  });

  it("does not read a truthy string as completion", () => {
    // Trello returns real booleans, but a strict check is what stops a "false" string from marking
    // every card done.
    expect(normalizeTrello([{ id: "a", name: "x", dueComplete: "false" }])[0]?.completed).toBe(false);
  });

  it("requires a string id", () => {
    expect(normalizeTrello([{ id: 12, name: "x" }])).toHaveLength(0);
  });
});

describe("Asana", () => {
  it("reads a task from the data envelope", () => {
    const [task] = normalizeAsana({ data: [{ gid: "1201", name: "File taxes", due_on: "2026-04-15", completed: false }] });
    expect(task).toEqual({ externalId: "1201", title: "File taxes", dueDate: "2026-04-15", completed: false });
  });

  it("uses due_at when there is no due_on", () => {
    expect(normalizeAsana({ data: [{ gid: "1", name: "x", due_at: "2026-04-15T22:00:00.000Z" }] })[0]?.dueDate).toBe("2026-04-15");
  });

  it("returns nothing when the envelope is missing or wrong", () => {
    expect(normalizeAsana({ errors: [{ message: "Not Authorized" }] })).toEqual([]);
    expect(normalizeAsana([{ gid: "1", name: "x" }])).toEqual([]);
    expect(normalizeAsana(null)).toEqual([]);
  });

  it("reads completion strictly", () => {
    expect(normalizeAsana({ data: [{ gid: "1", name: "x", completed: true }] })[0]?.completed).toBe(true);
    expect(normalizeAsana({ data: [{ gid: "1", name: "x", completed: "true" }] })[0]?.completed).toBe(false);
  });
});
