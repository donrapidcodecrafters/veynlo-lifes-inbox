import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ConflictService } from "./conflict.service";
import type { HouseholdService } from "../household/household.service";

const stubHouseholds = { activeHouseholdIds: async () => [] } as unknown as HouseholdService;

/**
 * CAL-003 "double-booked shared assets" — real integration test against a real Postgres. Covers the
 * buildable, vehicle-only slice: the SAME `vehicleProfiles` row referenced (via `relatedEntityIds`) by two
 * overlapping calendar events — including across two DIFFERENT household members' own events, which is
 * exactly the "a car needing to be in two places at once" scenario the spec calls out.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("ConflictService.vehicleConflicts", () => {
  let db: Database;
  let conflicts: ConflictService;
  let ownerAUserId: string;
  let ownerBUserId: string;
  let householdId: string;
  let vehicleId: string;
  let otherVehicleId: string;
  let dbAvailable = true;
  const insertedEventIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    conflicts = new ConflictService(db, stubHouseholds);
    try {
      ownerAUserId = generateId("user");
      ownerBUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerAUserId, email: `vehicle-conflict-a-${ownerAUserId}@example.com`, displayName: "Vehicle Conflict A" },
        { id: ownerBUserId, email: `vehicle-conflict-b-${ownerBUserId}@example.com`, displayName: "Vehicle Conflict B" },
      ]);
      householdId = generateId("household");
      await db.insert(schema.households).values({ id: householdId, name: "Vehicle Conflict Household", billingOwnerUserId: ownerAUserId });
      vehicleId = generateId("vehicle");
      otherVehicleId = generateId("vehicle");
      await db.insert(schema.vehicleProfiles).values([
        { id: vehicleId, ownerUserId: ownerAUserId, householdId, label: "Family Minivan" },
        { id: otherVehicleId, ownerUserId: ownerAUserId, householdId, label: "Dad's Truck" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ConflictService.vehicleConflicts tests — no reachable dev Postgres:", (err as Error).message);
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
      await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.householdId, householdId));
    }
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.householdId, householdId));
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerAUserId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerBUserId));
  });

  async function insertEvent(params: { ownerUserId: string; title: string; startInstant: string; endInstant: string; vehicleProfileId?: string; visibility?: "private" | "household" }) {
    const id = generateId("calendarEvent");
    insertedEventIds.push(id);
    await db.insert(schema.calendarEvents).values({
      id,
      ownerUserId: params.ownerUserId,
      householdId,
      title: params.title,
      start: { precision: "instant", instantUtc: params.startInstant, date: null, timezone: null, sourceText: null },
      startSort: new Date(params.startInstant),
      end: { precision: "instant", instantUtc: params.endInstant, date: null, timezone: null, sourceText: null },
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: params.visibility ?? "household",
      relatedEntityIds: params.vehicleProfileId ? [params.vehicleProfileId] : [],
    });
    return id;
  }

  it("flags the same vehicle double-booked by two DIFFERENT household members' overlapping events", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId: ownerAUserId, title: "School pickup", startInstant: "2026-11-02T15:00:00.000Z", endInstant: "2026-11-02T16:00:00.000Z", vehicleProfileId: vehicleId });
    const eventB = await insertEvent({ ownerUserId: ownerBUserId, title: "Grocery run", startInstant: "2026-11-02T15:30:00.000Z", endInstant: "2026-11-02T16:30:00.000Z", vehicleProfileId: vehicleId });

    const found = await conflicts.vehicleConflicts(eventA);
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("vehicle_double_booked");
    expect([...found[0]!.involvedEventIds].sort()).toEqual([eventA, eventB].sort());

    // Each owner sees the conflict via their own event id, without needing visibility into the other's event.
    const unresolvedForA = await conflicts.unresolvedConflicts(ownerAUserId);
    const unresolvedForB = await conflicts.unresolvedConflicts(ownerBUserId);
    expect(unresolvedForA.some((c) => c.id === found[0]!.id)).toBe(true);
    expect(unresolvedForB.some((c) => c.id === found[0]!.id)).toBe(true);
  });

  it("does not flag two overlapping events that reference DIFFERENT vehicles", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId: ownerAUserId, title: "Errand 1", startInstant: "2026-11-03T15:00:00.000Z", endInstant: "2026-11-03T16:00:00.000Z", vehicleProfileId: vehicleId });
    await insertEvent({ ownerUserId: ownerBUserId, title: "Errand 2", startInstant: "2026-11-03T15:00:00.000Z", endInstant: "2026-11-03T16:00:00.000Z", vehicleProfileId: otherVehicleId });

    const found = await conflicts.vehicleConflicts(eventA);
    expect(found).toHaveLength(0);
  });

  it("does not flag two non-overlapping bookings of the same vehicle", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId: ownerAUserId, title: "Morning errand", startInstant: "2026-11-04T13:00:00.000Z", endInstant: "2026-11-04T14:00:00.000Z", vehicleProfileId: vehicleId });
    await insertEvent({ ownerUserId: ownerBUserId, title: "Evening errand", startInstant: "2026-11-04T20:00:00.000Z", endInstant: "2026-11-04T21:00:00.000Z", vehicleProfileId: vehicleId });

    const found = await conflicts.vehicleConflicts(eventA);
    expect(found).toHaveLength(0);
  });

  it("does not spam a duplicate row when the same vehicle double-booking is re-detected", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId: ownerAUserId, title: "Trip A", startInstant: "2026-11-05T15:00:00.000Z", endInstant: "2026-11-05T16:00:00.000Z", vehicleProfileId: vehicleId });
    await insertEvent({ ownerUserId: ownerBUserId, title: "Trip B", startInstant: "2026-11-05T15:30:00.000Z", endInstant: "2026-11-05T16:30:00.000Z", vehicleProfileId: vehicleId });

    const first = await conflicts.vehicleConflicts(eventA);
    const second = await conflicts.vehicleConflicts(eventA);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it("returns nothing for an event with no vehicle tagged", async () => {
    if (!dbAvailable) return;
    const eventA = await insertEvent({ ownerUserId: ownerAUserId, title: "No vehicle event", startInstant: "2026-11-06T15:00:00.000Z", endInstant: "2026-11-06T16:00:00.000Z" });
    const found = await conflicts.vehicleConflicts(eventA);
    expect(found).toHaveLength(0);
  });
});
