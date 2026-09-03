import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { TripsService } from "./trips.service";
import { SharingService } from "../sharing/sharing.service";
import { ListsService } from "../lists/lists.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { MemoriesService } from "../memories/memories.service";
import type { ScheduleService } from "../schedule/schedule.service";

/**
 * Real HouseholdService against real dev Postgres, unlike trips.service.test.ts (which stubs
 * activeHouseholdIds to always return []) — this is the household-visibility path that stub can never
 * exercise. Covers two things found live during a Family/Household requirements re-audit:
 *
 * 1. `listTrips`/`tripDetail` correctly show a plain household member another member's trip (they already
 *    did — this is confirming that, not a fix), and post-leave revocation is immediate.
 * 2. `redeemTravelCredit` used to be a hard `ownerUserId !== userId` check even though `listTravelCredits`
 *    already shows a household member another member's travel credit — the same "list is more permissive
 *    than the action" inconsistency `CommerceService.redeemStoreCredit` avoids. Fixed to match.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;
// Not exercising "Add to calendar" here (see trips.segment-actions.test.ts) — a minimal stub satisfies
// TripsService's constructor.
const stubSchedule = { createEvent: async () => ({ id: "evt_stub", conflicts: [] }) } as unknown as ScheduleService;

describe("TripsService — real household membership", () => {
  let db: Database;
  let households: HouseholdService;
  let trips: TripsService;

  let ownerA: string;
  let memberC: string;
  let memberD: string;
  let strangerB: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    const sharing = new SharingService(db);
    const lists = new ListsService(db, households, sharing, stubMemories);
    trips = new TripsService(db, households, sharing, lists, stubSchedule);

    try {
      ownerA = generateId("user");
      memberC = generateId("user");
      memberD = generateId("user");
      strangerB = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerA, email: `trips-hh-owner-${ownerA}@example.com`, displayName: "Owner A" },
        { id: memberC, email: `trips-hh-memberc-${memberC}@example.com`, displayName: "Member C" },
        { id: memberD, email: `trips-hh-memberd-${memberD}@example.com`, displayName: "Member D" },
        { id: strangerB, email: `trips-hh-stranger-${strangerB}@example.com`, displayName: "Stranger B" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Trips Audit Household", billingOwnerUserId: ownerA });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerA, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberC, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberD, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping TripsService household-scope tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerA));
      await db.delete(schema.users).where(eq(schema.users.id, memberC));
      await db.delete(schema.users).where(eq(schema.users.id, memberD));
      await db.delete(schema.users).where(eq(schema.users.id, strangerB));
    }
  });

  it("trip visibility: stranger denied, household member sees it via listTrips/tripDetail, post-leave revocation is immediate", async () => {
    if (!dbAvailable) return;
    const { id: tripId } = await trips.createManualTrip(ownerA, { label: "Family trip to Lisbon", householdId });

    await expect(trips.tripDetail(tripId, strangerB)).rejects.toThrow();

    await expect(trips.tripDetail(tripId, memberC)).resolves.toBeTruthy();
    expect((await trips.listTrips(memberC)).some((t) => t.id === tripId)).toBe(true);

    await expect(trips.tripDetail(tripId, memberD)).resolves.toBeTruthy();
    await households.leave(householdId, memberD);
    await expect(trips.tripDetail(tripId, memberD)).rejects.toThrow();
    expect((await trips.listTrips(memberD)).some((t) => t.id === tripId)).toBe(false);

    await db.delete(schema.trips).where(eq(schema.trips.id, tripId));
  });

  it("redeemTravelCredit: stranger denied, household member can redeem another member's credit, post-leave revocation is immediate", async () => {
    if (!dbAvailable) return;
    const creditId = generateId("travelCredit");
    await db.insert(schema.travelCredits).values({
      id: creditId,
      ownerUserId: ownerA,
      householdId,
      providerName: "Test Air",
      amountMinorUnits: 5000,
      currency: "USD",
    });

    // A stranger can neither see it in the list nor redeem it.
    expect((await trips.listTravelCredits(strangerB)).some((c) => c.id === creditId)).toBe(false);
    await expect(trips.redeemTravelCredit(creditId, strangerB)).rejects.toThrow();

    // A plain active household member sees it in the list AND can redeem it — this is the fix: it used to
    // be visible via listTravelCredits but throw NOT_AUTHORIZED here.
    expect((await trips.listTravelCredits(memberC)).some((c) => c.id === creditId)).toBe(true);
    await trips.redeemTravelCredit(creditId, memberC);
    const [redeemed] = await db.select().from(schema.travelCredits).where(eq(schema.travelCredits.id, creditId)).limit(1);
    expect(redeemed?.redeemed).toBe(true);

    await db.delete(schema.travelCredits).where(eq(schema.travelCredits.id, creditId));
  });

  it("redeemTravelCredit: a member who has left the household can no longer redeem its shared credit", async () => {
    if (!dbAvailable) return;
    // memberD already left in the trip-visibility test above.
    const creditId = generateId("travelCredit");
    await db.insert(schema.travelCredits).values({
      id: creditId,
      ownerUserId: ownerA,
      householdId,
      providerName: "Test Air",
      amountMinorUnits: 2500,
      currency: "USD",
    });

    await expect(trips.redeemTravelCredit(creditId, memberD)).rejects.toThrow();

    await db.delete(schema.travelCredits).where(eq(schema.travelCredits.id, creditId));
  });

  /**
   * Found live during a fresh adversarial pass (real API, two real households, not this suite's usual
   * direct-insert setup): every test above inserts its travelCredits row directly with `householdId` set
   * by hand, which is exactly why this bug went uncaught — they exercise redeemTravelCredit/listTravelCredits
   * in isolation but never the actual write path a real user goes through. `createTravelCredit` itself
   * never set `householdId` on the row it inserted (discarded `assertTripAccess`'s return value instead of
   * reading `.householdId` off it), so a manually-added credit for a household-shared trip was invisible to
   * `listTravelCredits` for every member except its creator, and `redeemTravelCredit`'s own household-
   * inclusive check silently short-circuited to owner-only — confirmed live as a 403 NOT_AUTHORIZED for a
   * plain active household member redeeming their own household's trip credit. This test goes through the
   * real `createTravelCredit` entry point specifically so a regression here can't hide behind a
   * hand-populated test fixture again.
   */
  it("createTravelCredit populates householdId from its trip, so a household member can see and redeem it", async () => {
    if (!dbAvailable) return;
    const { id: tripId } = await trips.createManualTrip(ownerA, { label: "Trip with a credit", householdId });
    const { id: creditId } = await trips.createTravelCredit(ownerA, { tripId, providerName: "Test Air", amountMinorUnits: 7500, currency: "USD" });

    const [row] = await db.select().from(schema.travelCredits).where(eq(schema.travelCredits.id, creditId)).limit(1);
    expect(row?.householdId).toBe(householdId);

    expect((await trips.listTravelCredits(memberC)).some((c) => c.id === creditId)).toBe(true);
    await trips.redeemTravelCredit(creditId, memberC);
    const [redeemed] = await db.select().from(schema.travelCredits).where(eq(schema.travelCredits.id, creditId)).limit(1);
    expect(redeemed?.redeemed).toBe(true);

    await db.delete(schema.travelCredits).where(eq(schema.travelCredits.id, creditId));
    await db.delete(schema.trips).where(eq(schema.trips.id, tripId));
  });
});
