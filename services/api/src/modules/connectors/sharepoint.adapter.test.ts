import { describe, expect, it } from "vitest";
import { parseDriveCursors } from "./sharepoint.adapter";

/**
 * The per-library cursor map.
 *
 * This is the one piece of SharePoint that has no OneDrive equivalent, and it is the piece that decides
 * whether a sync resumes or starts over. A SharePoint connection is MANY document libraries, each with its
 * own delta stream, so `connections.cursor` holds a map rather than the single `@odata.deltaLink` string
 * OneDrive stores there.
 *
 * Two failure modes matter, and they are not symmetrical:
 *
 *   Losing a cursor  → one extra full walk of that library. Wasteful, recoverable, invisible to the user.
 *   Throwing on read → the connection can never sync again. Permanent, and it reports healthy while doing
 *                      nothing, which is the failure shape this codebase keeps finding.
 *
 * So every unreadable input must degrade to "no cursors" rather than raise.
 */
describe("the SharePoint per-library cursor map", () => {
  it("reads a map of library id to delta link", () => {
    const raw = JSON.stringify({ "drive-a": "https://graph.microsoft.com/delta?token=a", "drive-b": "https://graph.microsoft.com/delta?token=b" });
    expect(parseDriveCursors(raw)).toEqual({
      "drive-a": "https://graph.microsoft.com/delta?token=a",
      "drive-b": "https://graph.microsoft.com/delta?token=b",
    });
  });

  it("treats a missing cursor as no cursors, not as an error", () => {
    // A connection that has never synced. The commonest case, and it must not throw.
    expect(parseDriveCursors(null)).toEqual({});
    expect(parseDriveCursors("")).toEqual({});
  });

  it("degrades rather than throwing on text that is not JSON at all", () => {
    expect(parseDriveCursors("not json")).toEqual({});
    expect(parseDriveCursors("{unclosed")).toEqual({});
  });

  it("degrades on a bare OneDrive-shaped delta link", () => {
    // The column is shared with every other connector. A plain delta-link string is exactly what would be
    // there if this connection had ever been synced by OneDrive's adapter, or if a future refactor moved a
    // connection between providers. It is not a map, so it yields nothing — and the next sync simply walks
    // from the start instead of failing forever.
    expect(parseDriveCursors("https://graph.microsoft.com/v1.0/me/drive/root/delta?token=abc")).toEqual({});
  });

  it("degrades on JSON that is the wrong shape", () => {
    expect(parseDriveCursors("[]")).toEqual({});
    expect(parseDriveCursors('["a","b"]')).toEqual({});
    expect(parseDriveCursors("null")).toEqual({});
    expect(parseDriveCursors("42")).toEqual({});
    expect(parseDriveCursors('"a string"')).toEqual({});
  });

  it("drops entries whose value is not a usable link", () => {
    // A half-written map must not put `undefined` or a number where a URL belongs — the sync would then
    // request a malformed URL for that library on every run.
    const raw = JSON.stringify({ good: "https://graph.microsoft.com/delta?token=x", empty: "", numeric: 7, nested: { token: "y" }, nulled: null });
    expect(parseDriveCursors(raw)).toEqual({ good: "https://graph.microsoft.com/delta?token=x" });
  });

  it("does not let a crafted payload reach the prototype chain", () => {
    // `JSON.parse` makes `__proto__` an own property rather than polluting, so the guard's real job is
    // narrower and worth stating exactly: a key named `__proto__` must not end up in the returned map and
    // therefore must never be used as a library id to sync.
    const raw = '{"__proto__":"https://evil.example/delta","constructor":"https://evil.example/delta","real":"https://graph.microsoft.com/delta?token=z"}';
    const cursors = parseDriveCursors(raw);
    expect(cursors).toEqual({ real: "https://graph.microsoft.com/delta?token=z" });
    expect(Object.keys(cursors)).not.toContain("__proto__");
    expect(Object.keys(cursors)).not.toContain("constructor");
    // Nothing leaked onto Object's prototype either.
    expect(({} as Record<string, unknown>).real).toBeUndefined();
  });

  it("round-trips what the adapter writes", () => {
    // The adapter persists with JSON.stringify; this is the pair that has to agree.
    const written = { "drive-1": "https://graph.microsoft.com/delta?token=1", "drive-2": "https://graph.microsoft.com/delta?token=2" };
    expect(parseDriveCursors(JSON.stringify(written))).toEqual(written);
  });
});
