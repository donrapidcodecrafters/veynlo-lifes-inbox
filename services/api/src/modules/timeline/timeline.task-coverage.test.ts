import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { TimelineService } from "./timeline.service";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;

/**
 * Round-3 coverage gap fix: `tasks` was never one of Timeline's UNION branches (not in the original six,
 * not in the later School/Trips/Pets/Health Logistics sweep — see timeline.service.ts's own doc comment).
 * Found live: an automation-approved `add_task` run's task appeared in `GET /v1/tasks` but never in
 * `GET /v1/timeline`, while its sibling `add_calendar_event` action's row always did. This proves the new
 * `task` branch against real Postgres, mirroring timeline.phase3-scope.test.ts's own shape: household
 * sharing, direct assignment, a stranger seeing nothing, and a title that decrypts correctly (task titles
 * are `encryptedText`).
 */
describe("TimelineService — task coverage", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let timeline: TimelineService;

  let ownerUserId: string;
  let memberUserId: string;
  let assigneeUserId: string; // NOT a household member, only reachable via direct task assignment
  let strangerUserId: string;
  let householdId: string;
  let dbAvailable = true;

  const householdTaskId = generateId("task");
  const undatedTaskId = generateId("task");
  const assignedTaskId = generateId("task");
  const privatePersonalTaskId = generateId("task"); // owner's own, no householdId — still visible to owner only

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    timeline = new TimelineService(db, households, sharing);

    try {
      ownerUserId = generateId("user");
      memberUserId = generateId("user");
      assigneeUserId = generateId("user");
      strangerUserId = generateId("user");
      householdId = generateId("household");

      await db.insert(schema.users).values([
        { id: ownerUserId, email: `tl-task-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: memberUserId, email: `tl-task-member-${memberUserId}@example.com`, displayName: "Member" },
        { id: assigneeUserId, email: `tl-task-assignee-${assigneeUserId}@example.com`, displayName: "Assignee" },
        { id: strangerUserId, email: `tl-task-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Timeline Task Coverage Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);

      const now = new Date();
      await db.insert(schema.tasks).values([
        { id: householdTaskId, ownerUserId, householdId, title: "Shared household task", dueSort: now },
        { id: undatedTaskId, ownerUserId, householdId, title: "Undated task (falls back to createdAt)", dueSort: null },
        { id: assignedTaskId, ownerUserId, householdId: null, assignedToUserId: assigneeUserId, title: "Assigned to a non-member", dueSort: now },
        { id: privatePersonalTaskId, ownerUserId, householdId: null, title: "Owner's own personal task" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping TimelineService task-coverage tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.tasks).where(eq(schema.tasks.id, householdTaskId));
      await db.delete(schema.tasks).where(eq(schema.tasks.id, undatedTaskId));
      await db.delete(schema.tasks).where(eq(schema.tasks.id, assignedTaskId));
      await db.delete(schema.tasks).where(eq(schema.tasks.id, privatePersonalTaskId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, assigneeUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
    }
  });

  it("shows a household-shared task to a plain active member, with a correctly-decrypted title", async () => {
    if (!dbAvailable) return;
    const memberItems = (await timeline.getTimeline(memberUserId, null)).items;
    const shared = memberItems.find((i) => i.id === householdTaskId);
    expect(shared).toBeDefined();
    expect(shared?.kind).toBe("task");
    expect(shared?.title).toBe("Shared household task"); // not ciphertext
  });

  it("falls back to createdAt for a task with no due date, rather than being excluded or crashing", async () => {
    if (!dbAvailable) return;
    const ownerItems = (await timeline.getTimeline(ownerUserId, null)).items;
    const undated = ownerItems.find((i) => i.id === undatedTaskId);
    expect(undated).toBeDefined();
    expect(undated?.occurredAt).toBeTruthy();
  });

  it("shows a task to the user it's directly assigned to, even with no household relationship", async () => {
    if (!dbAvailable) return;
    const assigneeItems = (await timeline.getTimeline(assigneeUserId, null)).items.map((i) => i.id);
    expect(assigneeItems).toContain(assignedTaskId);

    const strangerItems = (await timeline.getTimeline(strangerUserId, null)).items.map((i) => i.id);
    expect(strangerItems).not.toContain(assignedTaskId);
  });

  it("never shows a stranger any task at all", async () => {
    if (!dbAvailable) return;
    const strangerItems = (await timeline.getTimeline(strangerUserId, null)).items.map((i) => i.id);
    expect(strangerItems).not.toContain(householdTaskId);
    expect(strangerItems).not.toContain(undatedTaskId);
    expect(strangerItems).not.toContain(privatePersonalTaskId);
  });

  it("never leaks a member's personal (no householdId, unassigned) task to another household member", async () => {
    if (!dbAvailable) return;
    const memberItems = (await timeline.getTimeline(memberUserId, null)).items.map((i) => i.id);
    expect(memberItems).not.toContain(privatePersonalTaskId);
    // ...but the owner still sees their own.
    const ownerItems = (await timeline.getTimeline(ownerUserId, null)).items.map((i) => i.id);
    expect(ownerItems).toContain(privatePersonalTaskId);
  });
});
