import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../shared/sharing.service";
import { ScheduleService } from "./schedule.service";

/**
 * §HH-002 "object-level privacy badge" — real, previously-missing gap: the delegated-household read path
 * already correctly excluded visibility:"private" events, but nothing anywhere ever set an event's
 * visibility to anything else, so the caregiver-delegation feature (schedule:read) was functionally inert.
 * Real DB-backed proof the new setEventVisibility mutation works and enforces ownership/household
 * membership.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const households = new HouseholdService(db, {} as never, {} as never);
const sharing = new SharingService(db);
const schedule = new ScheduleService(db, households, {} as never, {} as never, sharing);

const ownerId = generateId("user");
const strangerId = generateId("user");
const memberId = generateId("user");
const householdId = generateId("household");
const eventInHouseholdId = generateId("calendarEvent");
const eventSoloId = generateId("calendarEvent");

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
    { id: memberId, displayName: "Household member" },
  ]);
  await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerId });
  await db.insert(schema.householdMemberships).values({
    id: generateId("membership"),
    householdId,
    userId: memberId,
    role: "adult_member",
    status: "active",
  });
  await db.insert(schema.calendarEvents).values([
    {
      id: eventInHouseholdId,
      ownerUserId: ownerId,
      householdId,
      title: "Household event",
      start: { date: "2026-09-15", precision: "date", instantUtc: null, timezone: null, sourceText: null },
      startSort: new Date("2026-09-15"),
      source: "manual",
    },
    {
      id: eventSoloId,
      ownerUserId: ownerId,
      householdId: null,
      title: "Solo event",
      start: { date: "2026-09-16", precision: "date", instantUtc: null, timezone: null, sourceText: null },
      startSort: new Date("2026-09-16"),
      source: "manual",
    },
  ]);
});

afterAll(async () => {
  await db.delete(schema.resourceGrants).where(eq(schema.resourceGrants.resourceId, eventInHouseholdId));
  await db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, [eventInHouseholdId, eventSoloId]));
  await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.userId, memberId));
  await db.delete(schema.households).where(eq(schema.households.id, householdId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId, memberId]));
});

describe("ScheduleService.setEventVisibility", () => {
  it("refuses a stranger trying to change visibility on someone else's event", async () => {
    await expect(schedule.setEventVisibility(eventInHouseholdId, strangerId, "household")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a nonexistent event", async () => {
    await expect(schedule.setEventVisibility(generateId("calendarEvent"), ownerId, "household")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("refuses setting 'household' visibility on an event with no household at all", async () => {
    await expect(schedule.setEventVisibility(eventSoloId, ownerId, "household")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the real owner can genuinely make a household event visible, then private again", async () => {
    await schedule.setEventVisibility(eventInHouseholdId, ownerId, "household");
    let [row] = await db.select({ visibility: schema.calendarEvents.visibility }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventInHouseholdId));
    expect(row?.visibility).toBe("household");

    await schedule.setEventVisibility(eventInHouseholdId, ownerId, "private");
    [row] = await db.select({ visibility: schema.calendarEvents.visibility }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventInHouseholdId));
    expect(row?.visibility).toBe("private");
  });
});

/**
 * SHARE-001 "direct object sharing to a specific household member" — resource_grants existed and was read
 * by packages/authz/policy.ts but never written anywhere. Real DB-backed proof of the full loop: grant,
 * a real access check that only passes because of the grant (the event is "private" — household-wide
 * delegation would NOT let this member in), then revoke removes access again.
 */
describe("ScheduleService — direct object grants (SHARE-001)", () => {
  it("refuses granting to someone who isn't an active household member", async () => {
    await expect(schedule.shareEventWithMember(eventInHouseholdId, ownerId, strangerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses granting to yourself", async () => {
    await expect(schedule.shareEventWithMember(eventInHouseholdId, ownerId, ownerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a stranger with no grant cannot see the private event", async () => {
    expect(await schedule.eventDetail(eventInHouseholdId, strangerId)).toBeNull();
  });

  it("a real grant lets a specific member see an otherwise-private event, and revoking it removes access again", async () => {
    // Confirms the event is genuinely private first — otherwise this proves nothing about the grant itself.
    const [before] = await db.select({ visibility: schema.calendarEvents.visibility }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventInHouseholdId));
    expect(before?.visibility).toBe("private");

    expect(await schedule.eventDetail(eventInHouseholdId, memberId)).toBeNull();

    const { id: grantId } = await schedule.shareEventWithMember(eventInHouseholdId, ownerId, memberId);
    const detail = await schedule.eventDetail(eventInHouseholdId, memberId);
    expect(detail?.event.id).toBe(eventInHouseholdId);

    const grants = await schedule.listEventMemberGrants(eventInHouseholdId, ownerId);
    expect(grants.map((g) => g.id)).toContain(grantId);

    await schedule.revokeEventMemberAccess(eventInHouseholdId, ownerId, grantId);
    expect(await schedule.eventDetail(eventInHouseholdId, memberId)).toBeNull();
  });
});
