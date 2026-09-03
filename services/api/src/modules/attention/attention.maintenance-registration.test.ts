import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * HOMEOS-004/VEH-003/VEH-004 gap-close — real integration test against real dev Postgres, mirroring
 * attention.store-credit.test.ts's exact shape (real AttentionService.scanAndFileDeadlines() call, not a
 * mocked/narrowed scan method) since these two scans are wired into that same method.
 */
describe("AttentionService.scanAndFileDeadlines — maintenance rules and registration records", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let vehicleId: string;
  let vehicleId2: string;
  let propertyId: string;
  let homeAssetId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      vehicleId = generateId("vehicle");
      vehicleId2 = generateId("vehicle");
      propertyId = generateId("property");
      homeAssetId = generateId("homeAsset");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attention-maint-${ownerUserId}@example.com`, displayName: "Attention Maintenance Test" });
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "Maintenance scan test car", make: "Toyota", model: "Corolla", year: 2020 });
      // A separate vehicle for the "nowhere near due" test below — current-mileage is looked up per
      // VEHICLE (the highest odometer reading across ALL its rules), not per rule, so sharing `vehicleId`
      // with the "approaching" test's own 5,900 mi reading would make this one look approaching too.
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId2, ownerUserId, label: "Maintenance scan test car 2", make: "Toyota", model: "Corolla", year: 2021 });
      await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, label: "Maintenance scan test house", propertyType: "home" });
      await db.insert(schema.homeAssets).values({ id: homeAssetId, ownerUserId, propertyProfileId: propertyId, label: "Test HVAC" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService maintenance/registration tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.maintenanceRules).where(eq(schema.maintenanceRules.ownerUserId, ownerUserId));
    await db.delete(schema.registrationRecords).where(eq(schema.registrationRecords.ownerUserId, ownerUserId));
    await db.delete(schema.odometerObservations).where(eq(schema.odometerObservations.ownerUserId, ownerUserId));
    await db.delete(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId));
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId2));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("files a maintenance_due item for a calendar rule whose interval has elapsed, with an approximate confidence band and the honest guidance note for a seeded rule", async () => {
    if (!dbAvailable) return;
    const ruleId = generateId("maintenanceRule");
    const longAgo = new Date(Date.now() - 200 * 86_400_000); // well past a 90-day interval
    await db.insert(schema.maintenanceRules).values({
      id: ruleId,
      ownerUserId,
      homeAssetId,
      label: "HVAC filter",
      intervalType: "calendar",
      intervalDays: 90,
      lastPerformedDate: { precision: "date", instantUtc: null, date: longAgo.toISOString().slice(0, 10), timezone: null, sourceText: null },
      lastPerformedDateSort: longAgo,
      source: "seeded_generic_guidance",
      confidenceNote: "General guidance (every 60–90 days for a standard filter) — not manufacturer-specific.",
    });

    await attention.scanAndFileDeadlines();

    const [item] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "maintenance_rule"), eq(schema.attentionItems.linkedResourceId, ruleId)));
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe("maintenance_due");
    expect(item!.urgency).toBe("critical"); // overdue
    expect(item!.confidenceBand).toBe("approximate"); // seeded, never presented as verified fact
    expect(item!.reasonText).toContain("HVAC filter");
    expect(item!.reasonText).toContain("General guidance");
  });

  it("files a maintenance_due item for a mileage rule approaching its due mileage, at 'verified' confidence for a user-authored rule", async () => {
    if (!dbAvailable) return;
    const ruleId = generateId("maintenanceRule");
    await db.insert(schema.maintenanceRules).values({
      id: ruleId,
      ownerUserId,
      vehicleProfileId: vehicleId,
      label: "Tire rotation",
      intervalType: "mileage",
      intervalMiles: 6000,
      baselineMileage: 0,
      source: "user_added",
    });
    await db.insert(schema.odometerObservations).values({
      id: generateId("odometerObservation"),
      ownerUserId,
      vehicleProfileId: vehicleId,
      mileage: 5900, // within the 500-mile approach buffer of the 6,000 due point
      observedAt: { precision: "date", instantUtc: null, date: "2026-01-01", timezone: null, sourceText: null },
      observedAtSort: new Date("2026-01-01T00:00:00Z"),
    });

    await attention.scanAndFileDeadlines();

    const [item] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "maintenance_rule"), eq(schema.attentionItems.linkedResourceId, ruleId)));
    expect(item).toBeTruthy();
    expect(item!.confidenceBand).toBe("verified");
    expect(item!.reasonText).toContain("Tire rotation");
    expect(item!.reasonText.toLowerCase()).toContain("mi");
  });

  it("does NOT file a mileage rule that's nowhere near due yet", async () => {
    if (!dbAvailable) return;
    const ruleId = generateId("maintenanceRule");
    await db.insert(schema.maintenanceRules).values({
      id: ruleId,
      ownerUserId,
      vehicleProfileId: vehicleId2,
      label: "Far off rule",
      intervalType: "mileage",
      intervalMiles: 6000,
      baselineMileage: 0,
      source: "user_added",
    });
    await db.insert(schema.odometerObservations).values({
      id: generateId("odometerObservation"),
      ownerUserId,
      vehicleProfileId: vehicleId2,
      mileage: 100,
      observedAt: { precision: "date", instantUtc: null, date: "2026-01-01", timezone: null, sourceText: null },
      observedAtSort: new Date("2026-01-01T00:00:00Z"),
    });

    await attention.scanAndFileDeadlines();

    const [item] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "maintenance_rule"), eq(schema.attentionItems.linkedResourceId, ruleId)));
    expect(item).toBeUndefined();
  });

  it("files a registration_expiring item for a soon-due record, then escalates to registration_expired once the due date passes", async () => {
    if (!dbAvailable) return;
    const soon = new Date(Date.now() + 5 * 86_400_000);
    const recordId = generateId("registrationRecord");
    await db.insert(schema.registrationRecords).values({
      id: recordId,
      ownerUserId,
      vehicleProfileId: vehicleId,
      recordType: "inspection",
      jurisdiction: "TX",
      renewalDueDate: { precision: "date", instantUtc: null, date: soon.toISOString().slice(0, 10), timezone: null, sourceText: null },
      renewalDueDateSort: soon,
      reminderLeadDays: 30,
    });

    await attention.scanAndFileDeadlines();

    const [item] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "registration_record"), eq(schema.attentionItems.linkedResourceId, recordId)));
    expect(item).toBeTruthy();
    expect(item!.reasonCode).toBe("registration_expiring");
    expect(item!.reasonText).toContain("TX");
    expect(item!.reasonText).toContain("inspection");

    // Move the due date into the past and re-scan — should escalate to expired and flip the record's own status.
    const past = new Date(Date.now() - 2 * 86_400_000);
    await db
      .update(schema.registrationRecords)
      .set({ renewalDueDate: { precision: "date", instantUtc: null, date: past.toISOString().slice(0, 10), timezone: null, sourceText: null }, renewalDueDateSort: past })
      .where(eq(schema.registrationRecords.id, recordId));

    await attention.scanAndFileDeadlines();

    const [escalated] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "registration_record"), eq(schema.attentionItems.linkedResourceId, recordId)));
    expect(escalated!.reasonCode).toBe("registration_expired");
    expect(escalated!.urgency).toBe("critical");

    const [record] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, recordId));
    expect(record!.status).toBe("expired");
  });
});
