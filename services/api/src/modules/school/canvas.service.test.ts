import { describe, expect, it } from "vitest";
import { canvasOrigin, canvasTemporal, canvasTextFromHtml, normalizeCanvasAnnouncements, normalizeCanvasAssignments } from "./canvas.service";

/**
 * What Canvas hands over, and what this app is willing to believe about it.
 *
 * Two things here can hurt a household. A wrong due date is the obvious one — a parent plans around it
 * and the real deadline passes. The other is the address: Canvas is per-institution, so the host is typed
 * in by the user, which makes it the only API base URL in this codebase that is untrusted input.
 */
describe("the Canvas address", () => {
  it("accepts a bare hostname, because that is what people paste", () => {
    expect(canvasOrigin("myschool.instructure.com")).toBe("https://myschool.instructure.com");
    expect(canvasOrigin("  myschool.instructure.com  ")).toBe("https://myschool.instructure.com");
  });

  it("keeps only the origin, so a pasted deep link cannot smuggle a path into every request", () => {
    expect(canvasOrigin("https://myschool.instructure.com/courses/12345?enrollment=active")).toBe("https://myschool.instructure.com");
  });

  it("refuses plain http, which would put the access token on the wire in the clear", () => {
    expect(() => canvasOrigin("http://myschool.instructure.com")).toThrow(/https/i);
  });

  it("refuses a non-http scheme outright", () => {
    // `file:` and `gopher:` are not addresses a school runs Canvas on; they are attempts at something else.
    expect(() => canvasOrigin("file:///etc/passwd")).toThrow();
    expect(() => canvasOrigin("gopher://internal")).toThrow();
  });

  it("refuses something that is not an address at all", () => {
    expect(() => canvasOrigin("not a url")).toThrow();
  });

  it("keeps a non-standard port rather than silently dropping it", () => {
    // A district running Canvas behind a port is unusual but real; quietly rewriting their address to 443
    // would produce "couldn't reach Canvas" for an address that was correct.
    expect(canvasOrigin("https://canvas.school.edu:8443/x")).toBe("https://canvas.school.edu:8443");
  });
});

describe("Canvas timestamps", () => {
  it("reads an ISO timestamp", () => {
    const t = canvasTemporal("2026-04-15T23:59:00Z");
    expect(t?.precision).toBe("instant");
    expect(t?.instantUtc).toBe("2026-04-15T23:59:00.000Z");
  });

  it("keeps the original string as evidence", () => {
    // What Canvas actually said, preserved — so a later question about a date has something to check.
    expect(canvasTemporal("2026-04-15T23:59:00-06:00")?.sourceText).toBe("2026-04-15T23:59:00-06:00");
  });

  it("returns null rather than inventing a date", () => {
    expect(canvasTemporal(null)).toBeNull();
    expect(canvasTemporal("")).toBeNull();
    expect(canvasTemporal("   ")).toBeNull();
    expect(canvasTemporal("sometime next week")).toBeNull();
    expect(canvasTemporal(1_700_000_000)).toBeNull();
  });
});

describe("Canvas rich text", () => {
  it("reduces HTML to something readable", () => {
    expect(canvasTextFromHtml("<p>Read <b>chapter 4</b> and answer the questions.</p>")).toBe("Read chapter 4 and answer the questions.");
  });

  it("turns breaks and paragraphs into line breaks rather than running words together", () => {
    // Without this, "Bring a calculator<br>Wear sneakers" becomes "Bring a calculatorWear sneakers".
    expect(canvasTextFromHtml("Bring a calculator<br>Wear sneakers")).toBe("Bring a calculator\nWear sneakers");
  });

  it("decodes the entities a rich-text editor produces", () => {
    expect(canvasTextFromHtml("Smith &amp; Jones&nbsp;&mdash; see &lt;notes&gt;")).toContain("Smith & Jones");
    expect(canvasTextFromHtml("<p>&quot;Read this&quot;</p>")).toBe('"Read this"');
  });

  it("returns null for markup that carries no text", () => {
    expect(canvasTextFromHtml("<p></p>")).toBeNull();
    expect(canvasTextFromHtml("   ")).toBeNull();
    expect(canvasTextFromHtml(null)).toBeNull();
  });

  it("bounds a very long description", () => {
    expect(canvasTextFromHtml(`<p>${"x".repeat(9000)}</p>`)).toHaveLength(2000);
  });
});

describe("Canvas assignments", () => {
  const course = "Algebra II";

  it("reads an assignment with its due date", () => {
    const [item] = normalizeCanvasAssignments(
      [{ id: 991, name: "Chapter 4 Questions", due_at: "2026-04-15T23:59:00Z", description: "<p>Show your work.</p>" }],
      course,
    );
    expect(item).toEqual({
      uid: "assignment:991",
      title: "Chapter 4 Questions — Algebra II",
      start: { precision: "instant", instantUtc: "2026-04-15T23:59:00.000Z", date: null, timezone: null, sourceText: "2026-04-15T23:59:00Z" },
      description: "Show your work.",
      eventKind: "assignment",
    });
  });

  it("names the course in the title", () => {
    // A list of six rows all called "Weekly Quiz" tells a parent nothing about which class each is for.
    expect(normalizeCanvasAssignments([{ id: 1, name: "Weekly Quiz", due_at: "2026-04-15T12:00:00Z" }], "Biology")[0]?.title).toBe("Weekly Quiz — Biology");
  });

  it("still works when the course has no name", () => {
    expect(normalizeCanvasAssignments([{ id: 1, name: "Weekly Quiz" }], "")[0]?.title).toBe("Weekly Quiz");
  });

  it("gives a null start to an assignment with no due date rather than guessing one", () => {
    expect(normalizeCanvasAssignments([{ id: 1, name: "Extra credit", due_at: null }], course)[0]?.start).toBeNull();
  });

  it("skips an assignment with no id, because nothing could match it on the next sync", () => {
    expect(normalizeCanvasAssignments([{ name: "No id" }, { id: 2, name: "Fine" }], course)).toHaveLength(1);
  });

  it("prefixes the id so an assignment can never collide with an announcement", () => {
    const assignment = normalizeCanvasAssignments([{ id: 7, name: "A" }], course)[0];
    const announcement = normalizeCanvasAnnouncements([{ id: 7, title: "B" }], new Map())[0];
    expect(assignment?.uid).not.toBe(announcement?.uid);
  });

  it("survives an error payload instead of a list", () => {
    expect(normalizeCanvasAssignments({ errors: [{ message: "Invalid access token." }] }, course)).toEqual([]);
    expect(normalizeCanvasAssignments(null, course)).toEqual([]);
  });

  it("bounds a very long assignment title", () => {
    expect(normalizeCanvasAssignments([{ id: 1, name: "x".repeat(900) }], course)[0]?.title).toHaveLength(500);
  });
});

describe("Canvas announcements", () => {
  const courses = new Map([
    ["12", "Algebra II"],
    ["13", "Biology"],
  ]);

  it("reads an announcement and attributes it to its course", () => {
    const [item] = normalizeCanvasAnnouncements(
      [{ id: 55, title: "No class Friday", context_code: "course_12", posted_at: "2026-03-02T15:00:00Z", message: "<p>Enjoy the long weekend.</p>" }],
      courses,
    );
    expect(item?.uid).toBe("announcement:55");
    expect(item?.title).toBe("No class Friday — Algebra II");
    expect(item?.eventKind).toBe("announcement");
    expect(item?.description).toBe("Enjoy the long weekend.");
  });

  it("falls back to created_at when nothing was posted_at", () => {
    expect(normalizeCanvasAnnouncements([{ id: 1, title: "x", created_at: "2026-03-02T15:00:00Z" }], courses)[0]?.start?.instantUtc).toBe(
      "2026-03-02T15:00:00.000Z",
    );
  });

  it("omits the course name rather than guessing when the context is unfamiliar", () => {
    // An announcement attributed to the wrong class is worse than one attributed to none.
    expect(normalizeCanvasAnnouncements([{ id: 1, title: "Heads up", context_code: "course_999" }], courses)[0]?.title).toBe("Heads up");
    expect(normalizeCanvasAnnouncements([{ id: 1, title: "Heads up", context_code: "account_1" }], courses)[0]?.title).toBe("Heads up");
  });

  it("skips an announcement with no id", () => {
    expect(normalizeCanvasAnnouncements([{ title: "No id" }], courses)).toHaveLength(0);
  });

  it("survives an error payload instead of a list", () => {
    expect(normalizeCanvasAnnouncements({ errors: [{ message: "Unauthorized" }] }, courses)).toEqual([]);
  });
});
