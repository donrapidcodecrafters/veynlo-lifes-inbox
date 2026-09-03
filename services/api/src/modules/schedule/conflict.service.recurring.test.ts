import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type RecurrenceRule } from "@veynlo/core";
import { ConflictService } from "./conflict.service";
import type { HouseholdService } from "../household/household.service";

const stubHouseholds = { activeHouseholdIds: async () => [] } as unknown as HouseholdService;

/**
 * CAL-003 recurring-event conflict expansion — real integration test against a real Postgres, reproducing
 * exactly the gap docs/PHASE2_PENDING_CREDENTIALS.md documented: `detectOverlaps` used to only ever check a
 * recurring event's own stored anchor `start`/`end`, so a weekly-recurring event's 3rd future occurrence was
 * completely invisible to conflict detection. Also covers the bounded-window policy (a collision far past
 * the 90-day expansion window is correctly NOT flagged) and the per-occurrence-date dedup discipline (three
 * distinct colliding dates between the same pair get three distinct rows, and re-detecting the same
 * occurrence-date collision reuses the existing row rather than duplicating it).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("ConflictService.detectOverlaps — recurring expansion", () => {
  let db: Database;
  let conflicts: ConflictService;
  let ownerUserId: string;
  let dbAvailable = true;
  const insertedEventIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    conflicts = new ConflictService(db, stubHouseholds);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `conflict-recur-test-${ownerUserId}@example.com`, displayName: "Conflict Recur Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ConflictService recurring-expansion tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    if (insertedEventIds.length > 0) {
      const allConflicts = await db.select({ id: schema.scheduleConflicts.id, involvedEventIds: schema.scheduleConflicts.involvedEventIds }).from(schema.scheduleConflicts);
      const ownConflictIds = allConflicts.filter((c) => c.involvedEventIds.some((id) => insertedEventIds.includes(id))).map((c) => c.id);
      for (const id of ownConflictIds) {
        await db.delete(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, id));
      }
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function insertEvent(params: { title: string; startInstant: string; endInstant?: string; recurrenceRule?: RecurrenceRule }) {
    const id = generateId("calendarEvent");
    insertedEventIds.push(id);
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId,
      title: params.title,
      start: { precision: "instant", instantUtc: params.startInstant, date: null, timezone: null, sourceText: null },
      startSort: new Date(params.startInstant),
      end: params.endInstant ? { precision: "instant", instantUtc: params.endInstant, date: null, timezone: null, sourceText: null } : null,
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: "private",
      recurrenceRule: params.recurrenceRule ?? null,
    });
    return id;
  }

  it("flags a one-off event landing on a recurring series' 3rd future occurrence — the exact documented gap", async () => {
    if (!dbAvailable) return;
    // Weekly-recurring event anchored 2026-10-05 15:00 UTC; its 3rd occurrence is 2026-10-19 (documented repro).
    const weeklyRule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    const recurringEvent = await insertEvent({
      title: "Standing team sync",
      startInstant: "2026-10-05T15:00:00.000Z",
      endInstant: "2026-10-05T16:00:00.000Z",
      recurrenceRule: weeklyRule,
    });
    const oneOffEvent = await insertEvent({ title: "Vendor call", startInstant: "2026-10-19T15:30:00.000Z", endInstant: "2026-10-19T16:30:00.000Z" });

    const found = await conflicts.detectOverlaps(oneOffEvent, ownerUserId);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("time_overlap");
    expect([...found[0]!.involvedEventIds].sort()).toEqual([recurringEvent, oneOffEvent].sort());
    // The collision was only found via the recurring series' expanded 3rd occurrence, not its own anchor —
    // the row should record that specific occurrence date, not null.
    expect(found[0]!.occurrenceDate).toBe("2026-10-19");
  });

  it("also finds the collision when checked from the recurring event's own side (symmetric)", async () => {
    if (!dbAvailable) return;
    const weeklyRule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    const recurringEvent = await insertEvent({
      title: "Weekly checkup",
      startInstant: "2026-10-06T10:00:00.000Z",
      endInstant: "2026-10-06T11:00:00.000Z",
      recurrenceRule: weeklyRule,
    });
    // 2026-10-20 is this series' 3rd occurrence.
    const oneOffEvent = await insertEvent({ title: "Client visit", startInstant: "2026-10-20T10:15:00.000Z", endInstant: "2026-10-20T10:45:00.000Z" });

    const found = await conflicts.detectOverlaps(recurringEvent, ownerUserId);
    expect(found).toHaveLength(1);
    expect([...found[0]!.involvedEventIds].sort()).toEqual([recurringEvent, oneOffEvent].sort());
  });

  it("does not spam a duplicate row when the same recurring-occurrence collision is re-detected", async () => {
    if (!dbAvailable) return;
    const weeklyRule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    const _recurringEvent = await insertEvent({
      title: "Recurring standup",
      startInstant: "2026-10-07T09:00:00.000Z",
      endInstant: "2026-10-07T09:30:00.000Z",
      recurrenceRule: weeklyRule,
    });
    const oneOffEvent = await insertEvent({ title: "Interview", startInstant: "2026-10-21T09:10:00.000Z", endInstant: "2026-10-21T09:40:00.000Z" });

    const first = await conflicts.detectOverlaps(oneOffEvent, ownerUserId);
    const second = await conflicts.detectOverlaps(oneOffEvent, ownerUserId);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);

    const rows = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, first[0]!.id));
    expect(rows).toHaveLength(1);
  });

  it("records a SEPARATE conflict row per distinct colliding occurrence date, not one collapsed row", async () => {
    if (!dbAvailable) return;
    const weeklyRule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    const recurringEvent = await insertEvent({
      title: "Weekly office hours",
      startInstant: "2026-10-08T14:00:00.000Z",
      endInstant: "2026-10-08T15:00:00.000Z",
      recurrenceRule: weeklyRule,
    });
    // Two DIFFERENT one-off events colliding with two DIFFERENT future occurrences (10-22 and 10-29) of the
    // same recurring series.
    const collisionA = await insertEvent({ title: "Collision A", startInstant: "2026-10-22T14:15:00.000Z", endInstant: "2026-10-22T14:45:00.000Z" });
    const collisionB = await insertEvent({ title: "Collision B", startInstant: "2026-10-29T14:15:00.000Z", endInstant: "2026-10-29T14:45:00.000Z" });

    const foundA = await conflicts.detectOverlaps(collisionA, ownerUserId);
    const foundB = await conflicts.detectOverlaps(collisionB, ownerUserId);
    expect(foundA).toHaveLength(1);
    expect(foundB).toHaveLength(1);
    expect(foundA[0]!.id).not.toBe(foundB[0]!.id); // two distinct real-world collisions, two distinct rows
    expect(foundA[0]!.occurrenceDate).toBe("2026-10-22");
    expect(foundB[0]!.occurrenceDate).toBe("2026-10-29");

    const unresolved = await conflicts.unresolvedConflicts(ownerUserId);
    const involvingRecurring = unresolved.filter((c) => c.involvedEventIds.includes(recurringEvent));
    expect(involvingRecurring.length).toBeGreaterThanOrEqual(2);
  });

  it("does NOT expand a recurring event's occurrences past the bounded 90-day window", async () => {
    if (!dbAvailable) return;
    const weeklyRule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    // Anchored "now" so its own occurrences are computed relative to the real clock, matching the
    // bounded-window policy's "90 days forward from now" definition.
    const anchor = new Date();
    const anchorIso = anchor.toISOString();
    const recurringEvent = await insertEvent({ title: "Long-running weekly series", startInstant: anchorIso, endInstant: new Date(anchor.getTime() + 3_600_000).toISOString(), recurrenceRule: weeklyRule });

    // 98 days out (exactly 14 weeks — lands precisely on this series' weekly cadence, same weekday and
    // time-of-day as the anchor) but past the 90-day expansion window — should never be flagged. Picking a
    // date that DOES match the weekly phase (rather than an arbitrary far date) makes sure this test is
    // actually exercising the window cutoff, not just "the dates don't line up anyway."
    const farFuture = new Date(anchor.getTime() + 98 * 86_400_000);
    const farOneOff = await insertEvent({ title: "Far future one-off", startInstant: farFuture.toISOString(), endInstant: new Date(farFuture.getTime() + 3_600_000).toISOString() });

    const found = await conflicts.detectOverlaps(farOneOff, ownerUserId);
    expect(found.some((c) => c.involvedEventIds.includes(recurringEvent))).toBe(false);
  });
});
