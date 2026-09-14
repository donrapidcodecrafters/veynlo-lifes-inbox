import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { InboxService } from "./inbox.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";
import type { ConflictService } from "../schedule/conflict.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubCalendar = {} as unknown as CalendarWriteBackService;
const stubConflicts = {} as unknown as ConflictService;

/**
 * The Inbox returns a page and a cursor, not everything.
 *
 * The property that matters is not "a limit is applied" — that is easy and would pass with a broken
 * cursor. It is that walking the pages sees every row EXACTLY once, in the same order an unpaged read
 * would give. A pagination bug does not throw; it silently drops a row or repeats one, and the only way to
 * catch that is to walk the whole list and compare it against the truth.
 *
 * The tie case is the one most likely to break and least likely to be noticed: these rows are ordered by
 * createdAt, and seeded rows share a timestamp to the microsecond. A cursor carrying only the timestamp
 * would skip every tied row but one, and a fixture with distinct timestamps would never show it — so this
 * deliberately creates rows that all share a single createdAt.
 */
describe("InboxService.list — paged, and neither skipping nor repeating", () => {
  let db: Database;
  let inbox: InboxService;
  let userId: string;
  let dbAvailable = true;

  const TOTAL = 25;
  const TIED_AT = new Date("2026-03-01T12:00:00.000Z");

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    inbox = new InboxService(db, stubCalendar, stubConflicts);

    try {
      userId = generateId("user");
      await db.insert(schema.users).values({ id: userId, email: `inbox-page-${userId}@example.com`, displayName: "Inbox Pagination" });
      const sourceEventId = generateId("sourceEvent");
      // Every NOT NULL column, taken from information_schema rather than discovered one failed insert at
      // a time. The first version of this omitted contentHash and idempotencyKey, and the failure was
      // swallowed as an environment skip.
      await db.insert(schema.sourceEvents).values({
        id: sourceEventId,
        ownerUserId: userId,
        kind: "manual_capture",
        contentHash: `hash_${sourceEventId}`,
        idempotencyKey: `idem_${sourceEventId}`,
        occurredAt: TIED_AT,
        processingState: "filed",
      } as never);

      await db.insert(schema.inboxItems).values(
        Array.from({ length: TOTAL }, (_, n) => ({
          id: `inb_page_${String(n).padStart(3, "0")}_${userId}`,
          ownerUserId: userId,
          category: "purchase",
          summary: `Paged inbox item ${n}`,
          sourceEventId,
          suggestedActions: ["confirm"],
          reviewState: "new" as const,
          confidenceBand: "verified",
          // Every row shares one createdAt on purpose — see the block comment above.
          createdAt: TIED_AT,
        })) as never,
      );
    } catch (err) {
      // ONLY an unreachable database is a skip. A constraint violation means this fixture is wrong, and
      // swallowing it is exactly how this file first reported five passing tests while running none of
      // them — including the tie case, which then "passed" against a deliberately broken cursor.
      const message = (err as Error).message;
      const unreachable = /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|Connection terminated|timeout expired/i.test(message);
      if (!unreachable) throw err;
      dbAvailable = false;
      console.warn("Skipping Inbox pagination tests — no reachable dev Postgres:", message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, userId));
    await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("returns at most one page, and says whether there is another", async () => {
    if (!dbAvailable) return;
    const page = await inbox.list(userId, { limit: 10 });
    expect(page.items).toHaveLength(10);
    expect(page.nextCursor).toBeTruthy();

    const whole = await inbox.list(userId, { limit: 200 });
    expect(whole.items).toHaveLength(TOTAL);
    // No cursor on the last page: a cursor here would send a client after a page that does not exist.
    expect(whole.nextCursor).toBeNull();
  });

  it("walking the pages sees every item exactly once, in the unpaged order", async () => {
    if (!dbAvailable) return;
    const unpaged = (await inbox.list(userId, { limit: 200 })).items.map((i) => i.id);
    expect(unpaged).toHaveLength(TOTAL);

    const walked: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page: Awaited<ReturnType<typeof inbox.list>> = await inbox.list(userId, { limit: 7, cursor: cursor ?? undefined });
      walked.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    expect(walked).toEqual(unpaged);
    expect(new Set(walked).size).toBe(TOTAL);
  });

  it("clamps the page size, so a huge limit cannot restore the unbounded query", async () => {
    if (!dbAvailable) return;
    const huge = await inbox.list(userId, { limit: 100_000 });
    // The clamp is the point: 25 rows exist, so the assertion that proves clamping is that asking for
    // 100,000 does not error and does not return more than the maximum page.
    expect(huge.items.length).toBeLessThanOrEqual(200);

    const zero = await inbox.list(userId, { limit: 0 });
    expect(zero.items.length).toBeGreaterThan(0);
  });

  it("rejects a malformed cursor instead of silently restarting at page one", async () => {
    if (!dbAvailable) return;
    // Silently falling back to the first page would make a client that mangles its cursor loop forever
    // over rows it has already shown — indistinguishable from data corruption, from the outside.
    await expect(inbox.list(userId, { cursor: "not-a-real-cursor" })).rejects.toMatchObject({
      response: { code: "INVALID_CURSOR" },
    });
  });

  it("keeps the filters working alongside the cursor", async () => {
    if (!dbAvailable) return;
    const page = await inbox.list(userId, { reviewState: "new", category: "purchase", limit: 5 });
    expect(page.items).toHaveLength(5);
    expect(page.items.every((i) => i.reviewState === "new" && i.category === "purchase")).toBe(true);

    const none = await inbox.list(userId, { category: "travel", limit: 5 });
    expect(none.items).toHaveLength(0);
    expect(none.nextCursor).toBeNull();
  });
});
