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

/**
 * §TIME-001 Phase 3 coverage — found live during a fresh adversarial pass: the household-visibility fix
 * covered in timeline.household-scope.test.ts only ever touched the original six domains that existed when
 * Timeline was first built. School, Trips, Pets, and Health Logistics shipped later and were never wired
 * into the UNION query at all — not a visibility bug, a straight coverage gap (see timeline.service.ts's
 * own doc comment for the full story). This exercises the six new branches added to close it, reusing each
 * domain's OWN access-control shape as the source of truth for what "correct" means here — same posture as
 * the household-scope test, against real dev Postgres (the exact bug class most at risk of a subtle
 * visibility regression only shows up against real membership/delegation rows, not a mock).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;

describe("TimelineService — Phase 3 domain coverage (School/Trips/Pets/Health Logistics)", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let timeline: TimelineService;

  let ownerA: string;
  let memberC: string; // plain active member — no delegation, no grant
  let healthDelegate: string; // active member, holds a "health:read" caregiver delegation
  let strangerB: string; // no relationship at all
  let grantedFriend: string; // not a household member; holds direct resourceGrants
  let householdId: string;
  let dbAvailable = true;

  const schoolEventId = generateId("schoolEvent");
  const tripId = generateId("trip");
  const tripSegmentId = generateId("tripSegment");
  const deletedTripId = generateId("trip");
  const deletedTripSegmentId = generateId("tripSegment");
  const petId = generateId("pet");
  const vaccinationId = generateId("petVaccination");
  const unassignedVaccinationId = generateId("petVaccination");
  const petRefillId = generateId("refillReminder");
  const householdApptId = generateId("healthAppointment"); // owner-marked visibility "household"
  const privateApptId = generateId("healthAppointment"); // stays "private"
  const grantedApptId = generateId("healthAppointment"); // private, but explicitly granted to grantedFriend
  const healthRefillId = generateId("refillReminder"); // human-side (petProfileId null)

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    timeline = new TimelineService(db, households, sharing);

    try {
      ownerA = generateId("user");
      memberC = generateId("user");
      healthDelegate = generateId("user");
      strangerB = generateId("user");
      grantedFriend = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerA, email: `p3-owner-${ownerA}@example.com`, displayName: "Owner A" },
        { id: memberC, email: `p3-memberc-${memberC}@example.com`, displayName: "Member C" },
        { id: healthDelegate, email: `p3-healthd-${healthDelegate}@example.com`, displayName: "Health Delegate" },
        { id: strangerB, email: `p3-stranger-${strangerB}@example.com`, displayName: "Stranger B" },
        { id: grantedFriend, email: `p3-friend-${grantedFriend}@example.com`, displayName: "Granted Friend" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Phase 3 Timeline Household", billingOwnerUserId: ownerA });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerA, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberC, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: healthDelegate, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
      // healthDelegate holds an explicit "health:read" caregiver delegation — the ONE thing (besides
      // ownership/grant) that can ever surface another member's health-logistics row.
      await db.insert(schema.caregiverDelegations).values({
        id: generateId("caregiverDelegation"),
        householdId,
        delegateUserId: healthDelegate,
        scopes: ["health:read"],
        grantedByUserId: ownerA,
      });

      const now = new Date();
      const dateOnly = { precision: "date" as const, instantUtc: null, date: now.toISOString().slice(0, 10), timezone: null, sourceText: null };
      const instant = { precision: "instant" as const, instantUtc: now.toISOString(), date: null, timezone: null, sourceText: null };

      // --- School (§25) ---
      await db.insert(schema.schoolEvents).values({
        id: schoolEventId,
        ownerUserId: ownerA,
        householdId,
        kind: "game",
        title: "Soccer game",
        start: dateOnly,
        startSort: now,
        status: "confirmed",
      });

      // --- Trips (§26) ---
      await db.insert(schema.trips).values({
        id: tripId,
        ownerUserId: ownerA,
        householdId,
        label: "Trip to Lisbon",
        destinationLabel: "Lisbon",
        travelerUserIds: [ownerA],
      });
      await db.insert(schema.tripSegments).values({
        id: tripSegmentId,
        tripId,
        ownerUserId: ownerA,
        kind: "flight",
        providerName: "Delta",
        startAt: instant,
        startAtSort: now,
        detailsJson: {},
      });
      // A soft-deleted trip's segment must never surface on anyone's timeline, household member included.
      await db.insert(schema.trips).values({
        id: deletedTripId,
        ownerUserId: ownerA,
        householdId,
        label: "Cancelled trip",
        travelerUserIds: [ownerA],
        deletedAt: now,
      });
      await db.insert(schema.tripSegments).values({
        id: deletedTripSegmentId,
        tripId: deletedTripId,
        ownerUserId: ownerA,
        kind: "flight",
        providerName: "United",
        startAt: instant,
        startAtSort: now,
        detailsJson: {},
      });
      // grantedFriend is NOT a household member — only reachable via a direct "trip" resourceGrant.
      await db.insert(schema.resourceGrants).values({
        id: generateId("resourceGrant"),
        resourceType: "trip",
        resourceId: tripId,
        granteeUserId: grantedFriend,
        right: "view",
        grantedByUserId: ownerA,
      });

      // --- Pets (§28) ---
      await db.insert(schema.petProfiles).values({ id: petId, ownerUserId: ownerA, householdId, label: "Rex" });
      await db.insert(schema.petVaccinations).values({
        id: vaccinationId,
        ownerUserId: ownerA,
        householdId,
        petProfileId: petId,
        label: "Rabies",
        expirationDate: dateOnly,
        expirationDateSort: now,
      });
      // Unassigned (petProfileId null) — still an inbox triage candidate, must never appear on Timeline.
      await db.insert(schema.petVaccinations).values({
        id: unassignedVaccinationId,
        ownerUserId: ownerA,
        householdId,
        petProfileId: null,
        label: "Unassigned shot",
        expirationDate: dateOnly,
        expirationDateSort: now,
      });
      await db.insert(schema.refillReminders).values({
        id: petRefillId,
        ownerUserId: ownerA,
        householdId,
        petProfileId: petId,
        medicationName: "Heartworm chewable",
        nextRefillDate: dateOnly,
        nextRefillDateSort: now,
      });

      // --- Health Logistics (§27) ---
      await db.insert(schema.healthAppointments).values([
        {
          id: householdApptId,
          ownerUserId: ownerA,
          householdId,
          visibility: "household",
          appointmentType: "Dental",
          dateTime: instant,
          dateTimeSort: now,
        },
        {
          id: privateApptId,
          ownerUserId: ownerA,
          householdId,
          visibility: "private",
          appointmentType: "Vision",
          dateTime: instant,
          dateTimeSort: now,
        },
        {
          id: grantedApptId,
          ownerUserId: ownerA,
          householdId,
          visibility: "private",
          appointmentType: "Physical therapy",
          dateTime: instant,
          dateTimeSort: now,
        },
      ]);
      await db.insert(schema.resourceGrants).values({
        id: generateId("resourceGrant"),
        resourceType: "health_appointment",
        resourceId: grantedApptId,
        granteeUserId: grantedFriend,
        right: "view",
        grantedByUserId: ownerA,
      });
      await db.insert(schema.refillReminders).values({
        id: healthRefillId,
        ownerUserId: ownerA,
        householdId,
        petProfileId: null,
        medicationName: "Amoxicillin",
        nextRefillDate: dateOnly,
        nextRefillDateSort: now,
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping TimelineService Phase 3 coverage tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.resourceGrants).where(eq(schema.resourceGrants.grantedByUserId, ownerA));
      await db.delete(schema.refillReminders).where(eq(schema.refillReminders.householdId, householdId));
      await db.delete(schema.healthAppointments).where(eq(schema.healthAppointments.householdId, householdId));
      await db.delete(schema.petVaccinations).where(eq(schema.petVaccinations.householdId, householdId));
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.householdId, householdId));
      await db.delete(schema.tripSegments).where(eq(schema.tripSegments.tripId, tripId));
      await db.delete(schema.tripSegments).where(eq(schema.tripSegments.tripId, deletedTripId));
      await db.delete(schema.trips).where(eq(schema.trips.householdId, householdId));
      await db.delete(schema.schoolEvents).where(eq(schema.schoolEvents.householdId, householdId));
      await db.delete(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.householdId, householdId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerA));
      await db.delete(schema.users).where(eq(schema.users.id, memberC));
      await db.delete(schema.users).where(eq(schema.users.id, healthDelegate));
      await db.delete(schema.users).where(eq(schema.users.id, strangerB));
      await db.delete(schema.users).where(eq(schema.users.id, grantedFriend));
    }
  });

  it("§25 School: a plain household member sees the shared school event; a stranger sees none of it", async () => {
    if (!dbAvailable) return;
    const memberIds = (await timeline.getTimeline(memberC, null)).items.map((i) => i.id);
    expect(memberIds).toContain(schoolEventId);
    const strangerIds = (await timeline.getTimeline(strangerB, null)).items.map((i) => i.id);
    expect(strangerIds).not.toContain(schoolEventId);
  });

  it("§26 Trips: a household member sees the segment linked to its TRIP id, a granted non-member sees it via the grant, and a soft-deleted trip's segment never appears", async () => {
    if (!dbAvailable) return;
    const memberItems = (await timeline.getTimeline(memberC, null)).items;
    const segment = memberItems.find((i) => i.id === tripSegmentId);
    expect(segment).toBeDefined();
    expect(segment?.resourceId).toBe(tripId); // routes to /trips/:id, not a dead per-segment page
    expect(memberItems.map((i) => i.id)).not.toContain(deletedTripSegmentId);

    const strangerIds = (await timeline.getTimeline(strangerB, null)).items.map((i) => i.id);
    expect(strangerIds).not.toContain(tripSegmentId);

    const friendIds = (await timeline.getTimeline(grantedFriend, null)).items.map((i) => i.id);
    expect(friendIds).toContain(tripSegmentId); // via the direct "trip" resourceGrant, no household membership
  });

  it("§28 Pets: a household member sees the assigned vaccination/refill reminder but never an unassigned candidate", async () => {
    if (!dbAvailable) return;
    const memberIds = (await timeline.getTimeline(memberC, null)).items.map((i) => i.id);
    expect(memberIds).toContain(vaccinationId);
    expect(memberIds).toContain(petRefillId);
    expect(memberIds).not.toContain(unassignedVaccinationId);

    const strangerIds = (await timeline.getTimeline(strangerB, null)).items.map((i) => i.id);
    expect(strangerIds).not.toContain(vaccinationId);
  });

  it("§27 Health Logistics: a plain household member sees NOTHING, even a 'household'-visibility appointment — only a health:read delegate or an explicit grant does", async () => {
    if (!dbAvailable) return;
    // The critical regression check this whole file exists for: plain active membership (memberC has no
    // caregiver delegation) must never surface a health-logistics row, unlike every other domain above.
    const memberItems = (await timeline.getTimeline(memberC, null)).items.map((i) => i.id);
    expect(memberItems).not.toContain(householdApptId);
    expect(memberItems).not.toContain(privateApptId);
    expect(memberItems).not.toContain(healthRefillId);

    // A "health:read" delegate sees the owner's "household"-visibility appointment and the refill reminder...
    const delegateItems = (await timeline.getTimeline(healthDelegate, null)).items.map((i) => i.id);
    expect(delegateItems).toContain(householdApptId);
    expect(delegateItems).toContain(healthRefillId);
    // ...but NOT one still marked "private" — delegation alone isn't enough without the owner's explicit opt-in.
    expect(delegateItems).not.toContain(privateApptId);
    expect(delegateItems).not.toContain(grantedApptId);

    // A direct resourceGrant reaches a "private" appointment for its specific grantee, without any
    // household relationship at all — and reaches nothing else.
    const friendItems = (await timeline.getTimeline(grantedFriend, null)).items.map((i) => i.id);
    expect(friendItems).toContain(grantedApptId);
    expect(friendItems).not.toContain(householdApptId);
    expect(friendItems).not.toContain(privateApptId);

    // The owner always sees all three of their own appointments regardless of visibility.
    const ownerItems = (await timeline.getTimeline(ownerA, null)).items.map((i) => i.id);
    expect(ownerItems).toContain(householdApptId);
    expect(ownerItems).toContain(privateApptId);
    expect(ownerItems).toContain(grantedApptId);
  });
});
