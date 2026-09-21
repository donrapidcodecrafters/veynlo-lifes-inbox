import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { IngestionService } from "../ingestion/ingestion.service";
import { assertHostnameIsPublic } from "../ingestion/safe-url-fetcher";

/**
 * Canvas LMS — the Appendix A "Canvas" row, and the first school source that is a real API rather than a
 * feed or a forwarded mailbox.
 *
 * Canvas is buildable here for the same reason Todoist and Asana were: a user generates their own access
 * token (Account → Settings → New Access Token) with no application to register and no client secret this
 * deployment has to hold. Google Classroom, Schoology, PowerSchool and Infinite Campus all need a
 * district-approved OAuth application, which is a partnership, not a piece of code.
 *
 * What it brings in:
 *
 *   Assignments   — due dates, filed as school events of kind "assignment"
 *   Announcements — filed as kind "announcement"
 *
 * Grades are deliberately not read. The token can see them, and this app has no business storing a child's
 * grades to answer a question nobody asked it; what a household needs from Canvas is what is due and when.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why the host is treated as hostile input
 * ---------------------------------------------------------------------------------------------------
 * Canvas is per-institution — every district runs its own, at its own hostname — so unlike every other
 * API in this codebase the address is typed in by the user. That is the same shape as the custom IMAP
 * server, and it gets the same guard: https only, and `assertHostnameIsPublic` before any request, so a
 * pasted "http://169.254.169.254" cannot turn a school connector into a request forger against this
 * deployment's own network. The check runs on connect AND on every sync, because DNS can be repointed
 * after a host has been accepted.
 */

/** One sync's ceiling per category. A teacher with a decade of archived announcements is not this sync's problem. */
const MAX_COURSES = 20;
const MAX_ITEMS_PER_COURSE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
/** Canvas pages default to 10 items; asking for more keeps a normal course to a single request. */
const PAGE_SIZE = 100;

export interface CanvasItem {
  /** Unique within a source. Prefixed so an assignment and an announcement can never share a key. */
  uid: string;
  title: string;
  /** Null whenever Canvas gave no date — an assignment with no due date has none, and a guess is worse. */
  start: TemporalValue | null;
  description: string | null;
  eventKind: "assignment" | "announcement";
}

/**
 * Turn Canvas's HTML-bodied description into something readable.
 *
 * Canvas returns rich text. Storing raw HTML would put markup in front of the user wherever this is
 * displayed; stripping it to text is the honest minimum. Deliberately not a sanitiser — nothing here is
 * ever rendered as HTML, so the job is readability, not XSS defence.
 */
export function canvasTextFromHtml(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text ? text.slice(0, maxLength) : null;
}

/**
 * Canvas timestamps are ISO 8601 with a zone. Anything else is dropped rather than coerced.
 *
 * A due date is the whole point of this connector, so a wrong one is the worst failure it has: the user
 * plans around it and misses the real deadline.
 */
export function canvasTemporal(value: unknown): TemporalValue | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return { precision: "instant", instantUtc: parsed.toISOString(), date: null, timezone: null, sourceText: value };
}

/** Assignments, as Canvas's `/api/v1/courses/:id/assignments` returns them. */
export function normalizeCanvasAssignments(payload: unknown, courseName: string): CanvasItem[] {
  if (!Array.isArray(payload)) return [];
  const out: CanvasItem[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = a.id;
    if (typeof id !== "number" && typeof id !== "string") continue;
    const name = typeof a.name === "string" ? a.name.trim() : "";
    out.push({
      uid: `assignment:${id}`,
      // The course name is carried into the title because a school events list showing six rows called
      // "Chapter 4 Questions" tells a parent nothing about which class each belongs to.
      title: `${name || "Untitled assignment"}${courseName ? ` — ${courseName}` : ""}`.slice(0, 500),
      start: canvasTemporal(a.due_at),
      description: canvasTextFromHtml(a.description),
      eventKind: "assignment",
    });
  }
  return out;
}

/** Announcements, as Canvas's `/api/v1/announcements` returns them (a discussion topic under the hood). */
export function normalizeCanvasAnnouncements(payload: unknown, courseNames: Map<string, string>): CanvasItem[] {
  if (!Array.isArray(payload)) return [];
  const out: CanvasItem[] = [];
  for (const raw of payload) {
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    const id = a.id;
    if (typeof id !== "number" && typeof id !== "string") continue;
    const title = typeof a.title === "string" ? a.title.trim() : "";
    // `context_code` looks like "course_12345"; that is how an announcement names its course.
    const contextCode = typeof a.context_code === "string" ? a.context_code : "";
    const courseId = contextCode.startsWith("course_") ? contextCode.slice("course_".length) : "";
    const courseName = courseNames.get(courseId) ?? "";
    out.push({
      uid: `announcement:${id}`,
      title: `${title || "Announcement"}${courseName ? ` — ${courseName}` : ""}`.slice(0, 500),
      start: canvasTemporal(a.posted_at) ?? canvasTemporal(a.created_at),
      description: canvasTextFromHtml(a.message),
      eventKind: "announcement",
    });
  }
  return out;
}

/**
 * The host a user typed, reduced to an origin this code is willing to call.
 *
 * Returns the origin only — never a path — so a pasted
 * "https://school.instructure.com/courses/1?token=x" cannot smuggle a path or query into every request
 * this service makes.
 */
export function canvasOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim().includes("://") ? input.trim() : `https://${input.trim()}`);
  } catch {
    throw new BadRequestException({ code: "CANVAS_URL_INVALID", message: "That doesn't look like a web address. It usually looks like https://yourschool.instructure.com." });
  }
  if (url.protocol !== "https:") {
    throw new BadRequestException({
      code: "CANVAS_URL_INSECURE",
      message: "A Canvas address has to start with https — your access token would be sent in the clear otherwise.",
    });
  }
  return url.origin;
}

@Injectable()
export class CanvasService {
  private readonly logger = new Logger(CanvasService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
  ) {}

  /**
   * The SSRF check, as its own method so a test can reach a local server without the guard being weakened
   * for anything else.
   *
   * `assertHostnameIsPublic` correctly refuses 127.0.0.1, which means a test server cannot be called
   * through it — the same wall `imap.adapter.test.ts` hit, where the answer was to not exercise
   * `connect()` at all. Canvas cannot take that answer, because unlike IMAP the guard here runs on EVERY
   * request rather than only at connect, so skipping it would leave the whole sync path untested.
   *
   * A subclass in the test file overrides this one method and nothing else. The production class still
   * calls the real guard on every request, and the refusals have their own tests against it directly.
   */
  protected async assertHostAllowed(hostname: string): Promise<void> {
    await assertHostnameIsPublic(hostname);
  }

  private async request(origin: string, path: string, token: string): Promise<unknown> {
    // Re-checked on every call, not only at connect: a hostname accepted last week can point at an
    // internal address today.
    await this.assertHostAllowed(new URL(origin).hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
        // A redirect could leave this deployment following a Location header to somewhere the guard above
        // never saw — with the token attached.
        redirect: "manual",
      });
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException({
          code: "CANVAS_TOKEN_REJECTED",
          message: "Canvas rejected that access token. Generate a new one under Account, Settings, New Access Token.",
        });
      }
      if (!response.ok) throw new Error(`canvas responded ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Verify the host and token by using them, before any row is written.
   *
   * `/users/self` is the cheapest call that proves the token is real and belongs to somebody — a source
   * created from an unverified token sits in the household's list looking healthy and producing nothing.
   */
  async probe(baseUrl: string, token: string): Promise<{ origin: string; userName: string | null }> {
    const origin = canvasOrigin(baseUrl);
    try {
      const self = (await this.request(origin, "/api/v1/users/self", token)) as { name?: unknown };
      return { origin, userName: typeof self?.name === "string" ? self.name : null };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Never echo the provider's raw error — a Canvas error body can carry the request URL back.
      this.logger.warn(`canvas probe failed: ${(err as Error)?.name ?? "error"}`);
      throw new BadRequestException({
        code: "CANVAS_UNREACHABLE",
        message: "Couldn't reach that Canvas address. Check it looks like https://yourschool.instructure.com and try again.",
      });
    }
  }

  /** Everything this connector reads, in one place, so the sync below is just filing. */
  async fetchItems(origin: string, token: string): Promise<CanvasItem[]> {
    const courses = (await this.request(origin, `/api/v1/courses?enrollment_state=active&per_page=${PAGE_SIZE}`, token)) as unknown;
    if (!Array.isArray(courses)) return [];

    const courseNames = new Map<string, string>();
    const active = courses.slice(0, MAX_COURSES).filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === "object");
    for (const course of active) {
      const id = course.id;
      if (typeof id !== "number" && typeof id !== "string") continue;
      courseNames.set(String(id), typeof course.name === "string" ? course.name : "");
    }

    const items: CanvasItem[] = [];

    for (const [courseId, courseName] of courseNames) {
      try {
        const assignments = await this.request(
          origin,
          `/api/v1/courses/${encodeURIComponent(courseId)}/assignments?per_page=${PAGE_SIZE}`,
          token,
        );
        items.push(...normalizeCanvasAssignments(assignments, courseName).slice(0, MAX_ITEMS_PER_COURSE));
      } catch (err) {
        // One course a token cannot read must not lose the other nineteen. A concluded course, or one
        // whose teacher restricted access, is a normal state rather than a broken connection.
        this.logger.warn(`canvas: skipping assignments for one course: ${(err as Error)?.name ?? "error"}`);
      }
    }

    if (courseNames.size > 0) {
      try {
        const contextCodes = [...courseNames.keys()].map((id) => `context_codes[]=course_${encodeURIComponent(id)}`).join("&");
        const announcements = await this.request(origin, `/api/v1/announcements?${contextCodes}&per_page=${PAGE_SIZE}`, token);
        items.push(...normalizeCanvasAnnouncements(announcements, courseNames));
      } catch (err) {
        this.logger.warn(`canvas: announcements unavailable: ${(err as Error)?.name ?? "error"}`);
      }
    }

    return items;
  }

  async sync(schoolSourceId: string): Promise<{ itemCount: number }> {
    const [source] = await this.db.select().from(schema.schoolSources).where(eq(schema.schoolSources.id, schoolSourceId)).limit(1);
    if (!source || source.kind !== "canvas" || !source.apiBaseUrl || !source.apiToken || source.disconnectedAt) {
      return { itemCount: 0 };
    }

    let items: CanvasItem[];
    try {
      items = await this.fetchItems(source.apiBaseUrl, source.apiToken);
    } catch (err) {
      // Which failure this was decides what the household is told, and telling them the wrong one is not a
      // cosmetic mistake: "your token was rejected" sends someone to Canvas to generate a new one, and if
      // the real problem was the address no longer resolving anywhere public, the new token will not help
      // either — they will do it again, and again.
      //
      // Chosen on the error CODE, not on the exception class. The first version of this branch used
      // `err instanceof BadRequestException`, which is also what the SSRF guard and the scheme check throw,
      // so a host that had since been repointed at a private address would have been reported as a revoked
      // token.
      const code = (err as { getResponse?: () => unknown })?.getResponse?.();
      const errorCode = code && typeof code === "object" && "code" in code ? String((code as { code: unknown }).code) : "";
      const healthDetail =
        errorCode === "CANVAS_TOKEN_REJECTED"
          ? "Canvas rejected the saved access token. Canvas tokens expire and are revoked when a password changes — generate a new one and reconnect."
          : errorCode === "URL_UNREACHABLE" || errorCode === "CANVAS_URL_INSECURE" || errorCode === "CANVAS_URL_INVALID"
            ? "That Canvas address can no longer be reached safely. Check it still looks like https://yourschool.instructure.com and reconnect."
            : "Couldn't reach Canvas on the last sync.";
      await this.db
        .update(schema.schoolSources)
        .set({ health: "degraded", healthDetail, updatedAt: new Date() })
        .where(eq(schema.schoolSources.id, schoolSourceId));
      throw err;
    }

    let itemCount = 0;
    for (const item of items) {
      // An assignment with no due date is real and worth keeping, but it is not an event — there is
      // nothing to put on a calendar and nothing to be late for. Skipped rather than given a made-up date.
      if (!item.start) continue;
      const filed = await this.ingestion.ingestFeedSchoolEvent({
        ownerUserId: source.createdByUserId,
        householdId: source.householdId,
        schoolSourceId,
        schoolId: source.schoolId,
        uid: item.uid,
        title: item.title,
        start: item.start,
        isAllDay: false,
        location: null,
        description: item.description,
        canceled: false,
        feedKind: "canvas",
        eventKind: item.eventKind,
      });
      if (filed) itemCount += 1;
    }

    await this.db
      .update(schema.schoolSources)
      .set({ health: "healthy", healthDetail: null, lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, updatedAt: new Date() })
      .where(eq(schema.schoolSources.id, schoolSourceId));
    return { itemCount };
  }
}
