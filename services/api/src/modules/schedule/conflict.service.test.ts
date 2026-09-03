import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ConflictService } from "./conflict.service";
import type { HouseholdService } from "../household/household.service";

// Only school_transport conflict resolution touches HouseholdService, which this file's tests (all
// time_overlap, calendar-events-only) never exercise — a minimal stub is enough to satisfy the constructor.
const stubHouseholds = { activeHouseholdIds: async () => [] } as unknown as HouseholdService;

/**
 * CAL-003 "Conflict detection" — real integration test against a real Postgres, same pattern as
 * ingestion.dedup.test.ts (createDbClient, insert real rows, assert, clean up in afterAll, skip gracefully
 * if the DB isn't reachable). Covers the one check this pass actually built: true time overlap between two
 * events, including the precision-first dedup (re-detecting the same pair must not create a second
 * `schedule_conflicts` row) and that a genuinely non-overlapping pair is correctly left alone.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("ConflictService.detectOverlaps", () => {
  let db: Database;
  let conflicts: ConflictService;
  let ownerUserId: string;
  let otherOwnerUserId: string;
  let dbAvailable = true;
  const insertedEventIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    conflicts = new ConflictService(db, stubHouseholds);
    try {
      ownerUserId = generateId("user");
      otherOwnerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `conflict-test-${ownerUserId}@example.com`, displayName: "Conflict Test" },
        { id: otherOwnerUserId, email: `conflict-test-${otherOwnerUserId}@example.com`, displayName: "Conflict Test Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ConflictService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    if (insertedEventIds.length > 0) {
      // schedule_conflicts has no FK to calendar_events (involvedEventIds is a plain jsonb array, not a
      // relation), so deleting the events alone would leave orphaned conflict rows behind — find and
      // delete the ones this test created (by id, filtered in JS since jsonb-array-overlap isn't a plain
      // drizzle condition) before deleting the events themselves.
      const allConflicts = await db.select({ id: schema.scheduleConflicts.id, involvedEventIds: schema.scheduleConflicts.involvedEventIds }).from(schema.scheduleConflicts);
      const ownConflictIds = allConflicts.filter((c) => c.involvedEventIds.some((id) => insertedEventIds.includes(id))).map((c) => c.id);
      for (const id of ownConflictIds) {
        await db.delete(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, id));
      }
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, otherOwnerUserId));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, otherOwnerUserId));
    const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(remaining).toHaveLength(0);
  });

  async function insertEvent(params: { ownerUserId: string; title: string; startInstant: string; endInstant?: string }) {
    const id = generateId("calendarEvent");
    insertedEventIds.push(id);
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId: params.ownerUserId,
      title: params.title,
      start: { precision: "instant", instantUtc: params.startInstant, date: null, timezone: null, sourceText: null },
      startSort: new Date(params.startInstant),
      end: params.endInstant
        ? { precision: "instant", instantUtc: params.endInstant, date: null, timezone: null, sourceText: null }
        : null,
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: "private",
    });
    return id;
  }

  it("records a conflict when two of the same owner's events overlap in time", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId, title: "Dentist", startInstant: "2026-10-05T15:00:00.000Z", endInstant: "2026-10-05T16:00:00.000Z" });
    const eventB = await insertEvent({ ownerUserId, title: "Client call", startInstant: "2026-10-05T15:30:00.000Z", endInstant: "2026-10-05T16:30:00.000Z" });

    const found = await conflicts.detectOverlaps(eventA, ownerUserId);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("time_overlap");
    expect([...found[0]!.involvedEventIds].sort()).toEqual([eventA, eventB].sort());
    expect(found[0]!.resolvedAt).toBeNull();
  });

  it("does not create a duplicate conflict row when the same overlap is detected again", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId, title: "Standup", startInstant: "2026-10-06T09:00:00.000Z", endInstant: "2026-10-06T09:30:00.000Z" });
    const _eventB = await insertEvent({ ownerUserId, title: "1:1", startInstant: "2026-10-06T09:15:00.000Z", endInstant: "2026-10-06T09:45:00.000Z" });

    const first = await conflicts.detectOverlaps(eventA, ownerUserId);
    const second = await conflicts.detectOverlaps(eventA, ownerUserId);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id); // same row reused, not a new one

    const rows = await db
      .select()
      .from(schema.scheduleConflicts)
      .where(eq(schema.scheduleConflicts.id, first[0]!.id));
    expect(rows).toHaveLength(1);
  });

  it("does not flag two events that don't actually overlap in time", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId, title: "Morning run", startInstant: "2026-10-07T13:00:00.000Z", endInstant: "2026-10-07T14:00:00.000Z" });
    await insertEvent({ ownerUserId, title: "Lunch", startInstant: "2026-10-07T18:00:00.000Z", endInstant: "2026-10-07T19:00:00.000Z" });

    const found = await conflicts.detectOverlaps(eventA, ownerUserId);
    expect(found).toHaveLength(0);
  });

  it("does not flag overlapping events belonging to two unrelated owners", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId, title: "My meeting", startInstant: "2026-10-08T15:00:00.000Z", endInstant: "2026-10-08T16:00:00.000Z" });
    await insertEvent({ ownerUserId: otherOwnerUserId, title: "Someone else's meeting", startInstant: "2026-10-08T15:00:00.000Z", endInstant: "2026-10-08T16:00:00.000Z" });

    const found = await conflicts.detectOverlaps(eventA, ownerUserId);
    expect(found).toHaveLength(0);
  });

  it("resolveConflict marks the conflict resolved and it no longer shows as unresolved", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId, title: "Team sync", startInstant: "2026-10-09T10:00:00.000Z", endInstant: "2026-10-09T11:00:00.000Z" });
    const eventB = await insertEvent({ ownerUserId, title: "Vendor call", startInstant: "2026-10-09T10:30:00.000Z", endInstant: "2026-10-09T11:30:00.000Z" });
    const [found] = await conflicts.detectOverlaps(eventA, ownerUserId);
    expect(found).toBeDefined();

    const beforeUnresolved = await conflicts.unresolvedConflicts(ownerUserId);
    expect(beforeUnresolved.some((c) => c.id === found!.id)).toBe(true);

    await conflicts.resolveConflict(found!.id, ownerUserId);

    const afterUnresolved = await conflicts.unresolvedConflicts(ownerUserId);
    expect(afterUnresolved.some((c) => c.id === found!.id)).toBe(false);

    const [row] = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, found!.id));
    expect(row!.resolvedAt).not.toBeNull();
    void eventB;
  });
});
