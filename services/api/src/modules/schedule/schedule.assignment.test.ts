import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ScheduleService } from "./schedule.service";
import { ConflictService } from "./conflict.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { AssetsService } from "../assets/assets.service";

/**
 * FAM-003 "Assignment has acceptance/decline/complete" — real gap found via a spec-conformance audit:
 * `assignedToUserId` was a plain reassignment field with no accept/decline state at all. This tests the
 * new `assignmentStatus` lifecycle (unassigned → pending → accepted/declined) end to end, plus that both
 * the assignee-on-assignment and the owner-on-decline get notified (spec explicitly calls out "no one
 * accepts assignment" as an edge case the owner needs visibility into, not a silently stuck task).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("ScheduleService assignment accept/decline", () => {
  let db: Database;
  let schedule: ScheduleService;
  let ownerUserId: string;
  let assigneeUserId: string;
  let householdId: string;
  let dbAvailable = true;
  const notified: { ownerUserId: string; dedupeKey: string; title: string }[] = [];
  const stubHouseholds = { isActiveMember: async () => true } as unknown as HouseholdService;
  const stubNotifications = {
    createAndEnqueue: async (params: { ownerUserId: string; dedupeKey: string; title: string }) => {
      notified.push(params);
    },
  } as unknown as NotificationDeliveryService;
  // This test exercises assignment accept/decline, not VEH-007 mileage recurrence — stubbed no-op the same
  // way stubHouseholds/stubNotifications above are.
  const stubAssets = {} as unknown as AssetsService;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    // A real ConflictService (not a stub) — this test doesn't exercise conflict detection, but it's a
    // cheap, genuine instance rather than a mock of a class this file doesn't otherwise need to know about.
    // stubHouseholds satisfies ConflictService's school_transport-conflict resolution path (unused here).
    schedule = new ScheduleService(db, stubHouseholds, stubNotifications, new ConflictService(db, stubHouseholds), stubAssets);
    try {
      ownerUserId = generateId("user");
      assigneeUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `assign-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: assigneeUserId, email: `assign-assignee-${assigneeUserId}@example.com`, displayName: "Assignee" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ScheduleService assignment tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, assigneeUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("goes pending on assignment, notifies the assignee, and lets them accept", async () => {
    if (!dbAvailable) return;
    const { id: taskId } = await schedule.createTask(ownerUserId, { title: "Pick up dry cleaning", householdId, assignedToUserId: assigneeUserId });

    const [created] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(created?.assignmentStatus).toBe("pending");
    expect(notified.some((n) => n.dedupeKey === `task-assigned:${taskId}` && n.ownerUserId === assigneeUserId)).toBe(true);

    // Someone else (not the assignee) cannot accept it.
    await expect(schedule.acceptAssignment(taskId, ownerUserId)).rejects.toThrow();

    await schedule.acceptAssignment(taskId, assigneeUserId);
    const [accepted] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(accepted?.assignmentStatus).toBe("accepted");

    // Accepting again (no longer pending) is rejected, not silently a no-op success.
    await expect(schedule.acceptAssignment(taskId, assigneeUserId)).rejects.toThrow();

    await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
  });

  it("lets the assignee decline, and notifies the owner", async () => {
    if (!dbAvailable) return;
    const { id: taskId } = await schedule.createTask(ownerUserId, { title: "Take the dog to the vet", householdId, assignedToUserId: assigneeUserId });

    await schedule.declineAssignment(taskId, assigneeUserId);
    const [declined] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(declined?.assignmentStatus).toBe("declined");
    // Declining doesn't silently clear the assignee — the owner can still see who declined it.
    expect(declined?.assignedToUserId).toBe(assigneeUserId);
    expect(notified.some((n) => n.dedupeKey === `task-declined:${taskId}` && n.ownerUserId === ownerUserId)).toBe(true);

    // Reassigning resets to a fresh "pending" decision, even for the same person.
    await schedule.assignTask(taskId, ownerUserId, assigneeUserId);
    const [reassigned] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(reassigned?.assignmentStatus).toBe("pending");

    await db.delete(schema.tasks).where(eq(schema.tasks.id, taskId));
  });

  /**
   * Found live during a Family/Household requirements re-audit: `tasks()` shows every household member an
   * unassigned, shared household task (via `ownerOrDelegatedHousehold`), but `completeTask` used to only
   * accept the owner or the assignee — a member who could see and did the chore had no way to check it
   * off. A task assigned to a SPECIFIC other member must stay owner/assignee-only, though: this isn't a
   * blanket "anyone in the household can complete anyone's task" change.
   */
  it("lets any active household member complete an UNASSIGNED shared task, but not one assigned to someone specific", async () => {
    if (!dbAvailable) return;
    const thirdMemberUserId = generateId("user");

    const { id: unassignedTaskId } = await schedule.createTask(ownerUserId, { title: "Take out the trash", householdId });
    await schedule.completeTask(unassignedTaskId, thirdMemberUserId);
    const [completed] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, unassignedTaskId));
    expect(completed?.state).toBe("completed");
    await db.delete(schema.tasks).where(eq(schema.tasks.id, unassignedTaskId));

    const { id: assignedTaskId } = await schedule.createTask(ownerUserId, { title: "Pick up prescription", householdId, assignedToUserId: assigneeUserId });
    await expect(schedule.completeTask(assignedTaskId, thirdMemberUserId)).rejects.toThrow();
    // The actual assignee still can.
    await schedule.completeTask(assignedTaskId, assigneeUserId);
    const [assignedCompleted] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, assignedTaskId));
    expect(assignedCompleted?.state).toBe("completed");
    await db.delete(schema.tasks).where(eq(schema.tasks.id, assignedTaskId));
  });
});
