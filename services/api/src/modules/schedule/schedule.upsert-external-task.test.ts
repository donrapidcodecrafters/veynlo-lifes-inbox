import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ScheduleService } from "./schedule.service";
import { ConflictService } from "./conflict.service";
import type { HouseholdService } from "../household/household.service";
import type { AssetsService } from "../assets/assets.service";

/**
 * Phase 2 §52.2 "tasks/reminders integrations" — `upsertExternalTask` is what
 * GoogleTasksAdapter/MicrosoftToDoAdapter call on every sync. The interesting behavior is the dedup:
 * a second sync of the same provider task must update the existing row (title/due/completion) rather than
 * creating a duplicate, keyed on `(externalSyncProvider, externalSyncId)` — a real DB test since that's
 * exactly the kind of thing a mocked query builder would hide a mistake in.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => {} } as unknown as import("../notifications/notification-delivery.service").NotificationDeliveryService;
// This test exercises external-task upsert dedup, not VEH-007 mileage recurrence — stubbed no-op.
const stubAssets = {} as unknown as AssetsService;

describe("ScheduleService.upsertExternalTask", () => {
  let db: Database;
  let schedule: ScheduleService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    schedule = new ScheduleService(db, stubHouseholds, stubNotifications, new ConflictService(db, stubHouseholds), stubAssets);
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `upsert-task-test-${ownerUserId}@example.com`, displayName: "Upsert Task Test" },
        { id: otherUserId, email: `upsert-task-other-${otherUserId}@example.com`, displayName: "Upsert Task Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping upsertExternalTask tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  /**
   * Found live during the backend audit: the pre-fix lookup keyed only on `(externalSyncProvider,
   * externalSyncId)`, with no `ownerUserId` scope — neither column is unique in the schema, so if the
   * same external provider task id is ever visible to two different Veynlo accounts (e.g. the same
   * underlying Google/Microsoft account connected under two logins, or a shared task list), the "update"
   * branch would silently overwrite whichever user's task row happened to exist first with the OTHER
   * user's title/due-date/completion state. This proves the fix: two different owners syncing the exact
   * same `(provider, externalId)` each get their own row, and neither user's sync touches the other's data.
   */
  it("does not let a second owner's sync overwrite a first owner's task with the same (provider, externalId)", async () => {
    if (!dbAvailable) return;
    const externalId = generateId("task");

    const first = await schedule.upsertExternalTask({
      ownerUserId,
      householdId: null,
      provider: "google_tasks",
      externalId,
      title: "Owner's real task",
      dueDate: "2027-04-01",
      completed: false,
    });
    expect(first.created).toBe(true);

    // A different Veynlo account's sync happens to carry the identical (provider, externalId) pair.
    const second = await schedule.upsertExternalTask({
      ownerUserId: otherUserId,
      householdId: null,
      provider: "google_tasks",
      externalId,
      title: "Other user's unrelated task",
      dueDate: "2027-05-01",
      completed: true,
    });
    expect(second.created).toBe(true); // must create its own row, not update the owner's

    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.externalSyncId, externalId));
    expect(rows).toHaveLength(2);
    const ownerRow = rows.find((r) => r.ownerUserId === ownerUserId)!;
    const otherRow = rows.find((r) => r.ownerUserId === otherUserId)!;
    expect(ownerRow.state).toBe("open"); // untouched by the other user's "completed" sync
    expect(otherRow.state).toBe("completed");

    await db.delete(schema.tasks).where(eq(schema.tasks.externalSyncId, externalId));
  });

  it("creates once, then updates in place on a re-sync instead of duplicating", async () => {
    if (!dbAvailable) return;
    const externalId = generateId("task"); // stands in for a provider task id, just needs to be unique here

    const first = await schedule.upsertExternalTask({
      ownerUserId,
      householdId: null,
      provider: "google_tasks",
      externalId,
      title: "Buy birthday gift",
      dueDate: "2027-03-01",
      completed: false,
    });
    expect(first.created).toBe(true);

    const second = await schedule.upsertExternalTask({
      ownerUserId,
      householdId: null,
      provider: "google_tasks",
      externalId,
      title: "Buy birthday gift (updated)",
      dueDate: "2027-03-02",
      completed: true,
    });
    expect(second.created).toBe(false);

    const rows = await db.select().from(schema.tasks).where(eq(schema.tasks.externalSyncId, externalId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe("completed");
    expect(rows[0]?.dueCondition).toMatchObject({ date: "2027-03-02" });

    await db.delete(schema.tasks).where(eq(schema.tasks.externalSyncId, externalId));
  });
});
