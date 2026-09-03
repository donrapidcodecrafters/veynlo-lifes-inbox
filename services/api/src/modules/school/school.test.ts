import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SchoolService } from "./school.service";
import { HouseholdService } from "../household/household.service";
import { ConflictService } from "../schedule/conflict.service";
import type { SchoolIcsService } from "./school-ics.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { MailerService } from "../notifications/mailer.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * §25 SCH-001/006 + the school-relevant transport-conflict slice of CAL-003 — real integration test
 * against a real Postgres, mirroring conflict.service.test.ts's pattern. Covers: household-membership
 * visibility (a household member sees the household's school events; an outsider sees none — the exact
 * "forgot activeHouseholdIds" bug class this session has repeatedly found elsewhere), assignChild's
 * cross-household rejection, permission-form forward-only state transitions, and
 * ConflictService.schoolTransportConflicts (two different dependents needing transport at an overlapping
 * time -> flagged; same dependent's own back-to-back schedule -> not flagged).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubEntitlements = {} as unknown as EntitlementsService;
const stubMailer = {} as unknown as MailerService;
const stubSchoolIcs = {} as unknown as SchoolIcsService;
const stubQueue = { enqueueSchoolSourceSync: async () => {} } as unknown as QueueProducer;

describe("SchoolService + ConflictService.schoolTransportConflicts", () => {
  let db: Database;
  let households: HouseholdService;
  let conflicts: ConflictService;
  let school: SchoolService;
  let ownerUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let membershipId: string;
  let aliceId: string;
  let bobId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    households = new HouseholdService(db, stubEntitlements, stubMailer);
    conflicts = new ConflictService(db, households);
    school = new SchoolService(db, households, conflicts, stubSchoolIcs, stubQueue);
    try {
      ownerUserId = generateId("user");
      outsiderUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `school-svc-${ownerUserId}@example.com`, displayName: "School Svc Test" },
        { id: outsiderUserId, email: `school-svc-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      householdId = generateId("household");
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
      membershipId = generateId("membership");
      await db.insert(schema.householdMemberships).values({ id: membershipId, householdId, userId: ownerUserId, role: "household_owner", status: "active" });
      aliceId = generateId("dependentProfile");
      bobId = generateId("dependentProfile");
      await db.insert(schema.dependentProfiles).values([
        { id: aliceId, householdId, displayName: "Alice" },
        { id: bobId, householdId, displayName: "Bob" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping SchoolService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const events = await db.select({ id: schema.schoolEvents.id }).from(schema.schoolEvents).where(eq(schema.schoolEvents.householdId, householdId));
    const eventIds = events.map((e) => e.id);
    if (eventIds.length > 0) {
      const allConflicts = await db.select({ id: schema.scheduleConflicts.id, involvedEventIds: schema.scheduleConflicts.involvedEventIds }).from(schema.scheduleConflicts);
      const ownConflictIds = allConflicts.filter((c) => c.involvedEventIds.some((id) => eventIds.includes(id))).map((c) => c.id);
      for (const id of ownConflictIds) await db.delete(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, id));
    }
    await db.delete(schema.permissionForms).where(eq(schema.permissionForms.householdId, householdId));
    await db.delete(schema.schoolEvents).where(eq(schema.schoolEvents.householdId, householdId));
    await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.householdId, householdId));
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.id, membershipId));
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
    const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(remaining).toHaveLength(0);
  });

  async function insertSchoolEvent(params: { title: string; kind: string; startInstant: string; dependentId: string | null; requiresTransport: boolean }) {
    const id = generateId("schoolEvent");
    await db.insert(schema.schoolEvents).values({
      id,
      ownerUserId,
      householdId,
      dependentId: params.dependentId,
      kind: params.kind,
      title: params.title,
      start: { precision: "instant", instantUtc: params.startInstant, date: null, timezone: null, sourceText: null },
      startSort: new Date(params.startInstant),
      isAllDay: false,
      requiresDropoff: params.requiresTransport,
      requiresPickup: params.requiresTransport,
      source: "manual",
      status: "confirmed",
    });
    return id;
  }

  it("household visibility: a member sees the household's school events; an outsider sees none", async () => {
    if (!dbAvailable) return;
    await insertSchoolEvent({ title: "Practice", kind: "practice", startInstant: "2026-11-01T18:00:00.000Z", dependentId: aliceId, requiresTransport: true });

    const memberEvents = await school.listSchoolEvents(ownerUserId);
    expect(memberEvents.some((e) => e.title === "Practice")).toBe(true);

    const outsiderEvents = await school.listSchoolEvents(outsiderUserId);
    expect(outsiderEvents.some((e) => e.title === "Practice")).toBe(false);
  });

  it("assignChild rejects a dependent from a different household", async () => {
    if (!dbAvailable) return;
    const eventId = await insertSchoolEvent({ title: "Game", kind: "game", startInstant: "2026-11-02T18:00:00.000Z", dependentId: null, requiresTransport: true });
    const otherHouseholdId = generateId("household");
    await db.insert(schema.households).values({ id: otherHouseholdId, name: "Other Household", billingOwnerUserId: outsiderUserId });
    const otherDependentId = generateId("dependentProfile");
    await db.insert(schema.dependentProfiles).values({ id: otherDependentId, householdId: otherHouseholdId, displayName: "Not Ours" });

    await expect(school.assignChild(eventId, ownerUserId, otherDependentId)).rejects.toThrow();

    await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, otherDependentId));
    await db.delete(schema.households).where(eq(schema.households.id, otherHouseholdId));
  });

  it("assignChild succeeds for a dependent in the same household", async () => {
    if (!dbAvailable) return;
    const eventId = await insertSchoolEvent({ title: "Recital", kind: "practice", startInstant: "2026-11-03T18:00:00.000Z", dependentId: null, requiresTransport: false });
    await school.assignChild(eventId, ownerUserId, aliceId);
    const [row] = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.id, eventId));
    expect(row?.dependentId).toBe(aliceId);
  });

  /**
   * SCH-001 "correct school" — found live, missing entirely: named explicitly in the spec's own SCH-001
   * action list alongside "assign child" (tested above), but nothing let a user fix a misfiled `schoolId`
   * on an already-discovered event/form (e.g. a household with kids at two different schools, where the
   * extractor guessed wrong). Covers the same cross-household rejection assignChild gets, a same-household
   * correction, and clearing back to null.
   */
  it("correctSchoolEvent: rejects a school from a different household, succeeds for one in the same household, and null clears it", async () => {
    if (!dbAvailable) return;
    const rightSchoolId = generateId("school");
    await db.insert(schema.schools).values({ id: rightSchoolId, householdId, name: "Lincoln Elementary" });
    const eventId = await insertSchoolEvent({ title: "Picture day", kind: "picture_day", startInstant: "2026-11-05T18:00:00.000Z", dependentId: null, requiresTransport: false });

    const otherHouseholdId = generateId("household");
    await db.insert(schema.households).values({ id: otherHouseholdId, name: "Other Household", billingOwnerUserId: outsiderUserId });
    const wrongSchoolId = generateId("school");
    await db.insert(schema.schools).values({ id: wrongSchoolId, householdId: otherHouseholdId, name: "Not Our School" });
    await expect(school.correctSchoolEvent(eventId, ownerUserId, wrongSchoolId)).rejects.toThrow();

    await school.correctSchoolEvent(eventId, ownerUserId, rightSchoolId);
    let [row] = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.id, eventId));
    expect(row?.schoolId).toBe(rightSchoolId);

    await school.correctSchoolEvent(eventId, ownerUserId, null);
    [row] = await db.select().from(schema.schoolEvents).where(eq(schema.schoolEvents.id, eventId));
    expect(row?.schoolId).toBeNull();

    await db.delete(schema.schools).where(eq(schema.schools.id, wrongSchoolId));
    await db.delete(schema.households).where(eq(schema.households.id, otherHouseholdId));
    await db.delete(schema.schools).where(eq(schema.schools.id, rightSchoolId));
  });

  it("correctPermissionFormSchool: the form-side counterpart works the same way", async () => {
    if (!dbAvailable) return;
    const schoolId = generateId("school");
    await db.insert(schema.schools).values({ id: schoolId, householdId, name: "Lincoln Elementary" });
    const { id: formId } = await school.createPermissionForm(ownerUserId, { householdId, title: "Field Trip Slip", dependentId: aliceId, dueIso: "2026-12-05" });

    await school.correctPermissionFormSchool(formId, ownerUserId, schoolId);
    const [row] = await db.select().from(schema.permissionForms).where(eq(schema.permissionForms.id, formId));
    expect(row?.schoolId).toBe(schoolId);

    await db.delete(schema.schools).where(eq(schema.schools.id, schoolId));
  });

  it("permission form state only advances forward, never backward or sideways", async () => {
    if (!dbAvailable) return;
    const { id } = await school.createPermissionForm(ownerUserId, { householdId, title: "Field Trip Slip", dependentId: aliceId, dueIso: "2026-12-01" });

    await school.advanceFormState(id, ownerUserId, "opened");
    let [row] = await db.select().from(schema.permissionForms).where(eq(schema.permissionForms.id, id));
    expect(row?.state).toBe("opened");

    await expect(school.advanceFormState(id, ownerUserId, "discovered")).rejects.toThrow();
    await expect(school.advanceFormState(id, ownerUserId, "opened")).rejects.toThrow();

    await school.advanceFormState(id, ownerUserId, "submitted");
    [row] = await db.select().from(schema.permissionForms).where(eq(schema.permissionForms.id, id));
    expect(row?.state).toBe("submitted");
  });

  it("flags a transport conflict when two DIFFERENT dependents need drop-off/pickup at an overlapping time", async () => {
    if (!dbAvailable) return;
    const eventA = await insertSchoolEvent({ title: "Alice soccer game", kind: "game", startInstant: "2026-11-10T18:00:00.000Z", dependentId: aliceId, requiresTransport: true });
    const eventB = await insertSchoolEvent({ title: "Bob band practice", kind: "practice", startInstant: "2026-11-10T18:15:00.000Z", dependentId: bobId, requiresTransport: true });

    const found = await conflicts.schoolTransportConflicts(eventA, householdId);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("school_transport");
    expect([...found[0]!.involvedEventIds].sort()).toEqual([eventA, eventB].sort());
  });

  it("does not flag two events belonging to the SAME dependent as a transport conflict", async () => {
    if (!dbAvailable) return;
    const eventA = await insertSchoolEvent({ title: "Alice game", kind: "game", startInstant: "2026-11-12T18:00:00.000Z", dependentId: aliceId, requiresTransport: true });
    await insertSchoolEvent({ title: "Alice practice right after", kind: "practice", startInstant: "2026-11-12T18:10:00.000Z", dependentId: aliceId, requiresTransport: true });

    const found = await conflicts.schoolTransportConflicts(eventA, householdId);
    expect(found).toHaveLength(0);
  });

  it("does not flag an unassigned event (no dependent to conflict over)", async () => {
    if (!dbAvailable) return;
    const eventA = await insertSchoolEvent({ title: "Unassigned game", kind: "game", startInstant: "2026-11-14T18:00:00.000Z", dependentId: null, requiresTransport: true });
    await insertSchoolEvent({ title: "Bob practice same time", kind: "practice", startInstant: "2026-11-14T18:05:00.000Z", dependentId: bobId, requiresTransport: true });

    const found = await conflicts.schoolTransportConflicts(eventA, householdId);
    expect(found).toHaveLength(0);
  });

  /**
   * The actual gap this pass closes (docs/PHASE3_PENDING_CREDENTIALS.md's "Family Transport Conflicts"):
   * whether an available adult driver actually exists, not just "two kids need rides." The household's
   * only adult (ownerUserId, household_owner) gets a private calendar event covering BOTH drop-off/pickup
   * windows below, so nobody is free for either — this must flag `severity: "elevated"` with both event ids
   * named in `unavailableEventIds`, and the private busy event's own TITLE must never surface anywhere in
   * the result (adversarially checked — see householdAdultBusyIntervals' own privacy discipline).
   */
  it("flags severity 'elevated' when NO adult household member is free for either drop-off/pickup window", async () => {
    if (!dbAvailable) return;
    const sensitiveTitle = "owner's confidential 1:1 — do not leak";
    const busyEventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: busyEventId,
      ownerUserId,
      householdId,
      title: sensitiveTitle,
      start: { precision: "instant", instantUtc: "2026-11-20T17:30:00.000Z", date: null, timezone: null, sourceText: null },
      startSort: new Date("2026-11-20T17:30:00.000Z"),
      end: { precision: "instant", instantUtc: "2026-11-20T19:30:00.000Z", date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: "private",
    });

    const eventA = await insertSchoolEvent({ title: "Alice game (no ride)", kind: "game", startInstant: "2026-11-20T18:00:00.000Z", dependentId: aliceId, requiresTransport: true });
    const eventB = await insertSchoolEvent({ title: "Bob practice (no ride)", kind: "practice", startInstant: "2026-11-20T18:10:00.000Z", dependentId: bobId, requiresTransport: true });

    const found = await conflicts.schoolTransportConflicts(eventA, householdId);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("elevated");
    expect([...found[0]!.unavailableEventIds].sort()).toEqual([eventA, eventB].sort());

    // Adversarial: the owner's busy calendar event was PRIVATE and its title is genuinely sensitive — it
    // must never appear anywhere in the conflict row this pipeline returns, only the busy/free fact that
    // drove the severity decision.
    const serialized = JSON.stringify(found);
    expect(serialized).not.toContain(sensitiveTitle);
    expect(serialized).not.toContain("confidential");

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, busyEventId));
  });

  /**
   * Same setup as above, but with a second, fully-free adult household member added — at least one adult is
   * now free for each event's window, so this must downgrade to `severity: "standard"` with an empty
   * `unavailableEventIds`. Also exercises the "refresh on re-check" behavior: re-running
   * `schoolTransportConflicts` for the SAME already-detected pair after household availability changes
   * updates the existing row in place rather than leaving it stuck at its first-detected severity.
   */
  it("downgrades to severity 'standard' once a free adult household member exists, refreshing the existing conflict row", async () => {
    if (!dbAvailable) return;
    const busyEventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: busyEventId,
      ownerUserId,
      householdId,
      title: "owner busy again",
      start: { precision: "instant", instantUtc: "2026-11-21T17:30:00.000Z", date: null, timezone: null, sourceText: null },
      startSort: new Date("2026-11-21T17:30:00.000Z"),
      end: { precision: "instant", instantUtc: "2026-11-21T19:30:00.000Z", date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: "private",
    });
    const eventA = await insertSchoolEvent({ title: "Alice game (refresh)", kind: "game", startInstant: "2026-11-21T18:00:00.000Z", dependentId: aliceId, requiresTransport: true });
    const eventB = await insertSchoolEvent({ title: "Bob practice (refresh)", kind: "practice", startInstant: "2026-11-21T18:10:00.000Z", dependentId: bobId, requiresTransport: true });

    const firstPass = await conflicts.schoolTransportConflicts(eventA, householdId);
    expect(firstPass[0]!.severity).toBe("elevated");
    const conflictId = firstPass[0]!.id;

    // Add a second, fully-free adult to the household — nothing on their calendar at all.
    const freeAdultUserId = generateId("user");
    await db.insert(schema.users).values({ id: freeAdultUserId, email: `school-svc-free-adult-${freeAdultUserId}@example.com`, displayName: "Free Adult" });
    const freeAdultMembershipId = generateId("membership");
    await db.insert(schema.householdMemberships).values({ id: freeAdultMembershipId, householdId, userId: freeAdultUserId, role: "adult_member", status: "active" });

    const secondPass = await conflicts.schoolTransportConflicts(eventA, householdId);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0]!.id).toBe(conflictId); // same row, refreshed — not a new one
    expect(secondPass[0]!.severity).toBe("standard");
    expect(secondPass[0]!.unavailableEventIds).toEqual([]);

    const [persisted] = await db.select().from(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, conflictId));
    expect(persisted?.severity).toBe("standard");

    void eventB;
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.id, freeAdultMembershipId));
    await db.delete(schema.users).where(eq(schema.users.id, freeAdultUserId));
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, busyEventId));
  });
});
