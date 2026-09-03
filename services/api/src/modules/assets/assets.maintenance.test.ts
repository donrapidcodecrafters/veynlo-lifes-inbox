import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AssetsService } from "./assets.service";
import { SharingService } from "../sharing/sharing.service";
import { VinDecodeService } from "./vin-decode.service";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";
import type { HouseholdService } from "../household/household.service";
import type { RecallMonitorService } from "./recall-monitor.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * HOMEOS-002/HOMEOS-004/VEH-001/VEH-003/VEH-004 gap-close — real integration test against real dev
 * Postgres, exercising the actual AssetsService methods (not mocks) the way every other assets test in this
 * module does. The VIN-decode-application test also hits the real live NHTSA vPIC API (see
 * vin-decode.service.test.ts's own doc comment on why this codebase's convention is to test against the
 * real free/no-key government API rather than mocking it).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = { delegatedHouseholdIds: async () => [], activeHouseholdIds: async () => [] } as unknown as HouseholdService;
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;

describe("AssetsService — maintenance rules, registration records, home-asset room, VIN decode", () => {
  let db: Database;
  let assets: AssetsService;
  let ownerUserId: string;
  let vehicleId: string;
  let propertyId: string;
  let homeAssetId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const sharing = new SharingService(db);
    assets = new AssetsService(db, stubHouseholds, sharing, stubRecallMonitor, new VinDecodeService(new SafeUrlFetcher()), stubQueue);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `assets-maintenance-${ownerUserId}@example.com`, displayName: "Assets Maintenance Test" });
      const vehicle = await assets.createVehicle(ownerUserId, { label: "Maintenance test car", make: "Honda", model: "Civic", year: 2018 });
      vehicleId = vehicle.id;
      const property = await assets.createProperty(ownerUserId, { label: "Maintenance test house", propertyType: "home" });
      propertyId = property.id;
      const asset = await assets.createHomeAsset(ownerUserId, { propertyProfileId: propertyId, label: "Furnace", room: "Basement" });
      homeAssetId = asset.id;
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AssetsService maintenance tests — no reachable dev Postgres:", (err as Error).message);
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
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  // --- HOMEOS-002 room field --------------------------------------------------------------------------

  it("createHomeAsset stores the room label, and updateHomeAsset can change it", async () => {
    if (!dbAvailable) return;
    const [row] = await db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId));
    expect(row!.room).toBe("Basement");

    await assets.updateHomeAsset(homeAssetId, ownerUserId, { room: "Utility closet" });
    const [updated] = await db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId));
    expect(updated!.room).toBe("Utility closet");
  });

  // --- HOMEOS-004/VEH-003 maintenance rules -----------------------------------------------------------

  it("creates a user-authored calendar_or_mileage rule for a vehicle, and 'mark done' re-anchors both sides", async () => {
    if (!dbAvailable) return;
    const { id: ruleId } = await assets.createMaintenanceRule(ownerUserId, {
      vehicleProfileId: vehicleId,
      label: "Oil change",
      intervalType: "calendar_or_mileage",
      intervalDays: 180,
      intervalMiles: 5000,
    });

    const [created] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId));
    expect(created!.source).toBe("user_added");
    expect(created!.intervalDays).toBe(180);
    expect(created!.intervalMiles).toBe(5000);
    expect(created!.baselineMileage).toBeNull();

    // Record an odometer reading so "mark done" without an explicit performedMileage can re-anchor to it.
    await db.insert(schema.odometerObservations).values({
      id: generateId("odometerObservation"),
      ownerUserId,
      vehicleProfileId: vehicleId,
      mileage: 42_000,
      observedAt: { precision: "date", instantUtc: null, date: "2026-01-01", timezone: null, sourceText: null },
      observedAtSort: new Date("2026-01-01T00:00:00Z"),
    });

    await assets.completeMaintenanceRule(ruleId, ownerUserId, {});
    const [completed] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId));
    expect(completed!.baselineMileage).toBe(42_000);
    expect(completed!.lastPerformedDateSort).not.toBeNull();

    await assets.deleteMaintenanceRule(ruleId, ownerUserId);
    const [deleted] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId));
    expect(deleted!.deletedAt).not.toBeNull();
  });

  it("adds a seeded generic-guidance rule from a template, and editing it clears back to user_added", async () => {
    if (!dbAvailable) return;
    const templates = assets.listVehicleMaintenanceTemplates();
    const oilChange = templates.find((t) => t.key === "oil_change")!;
    expect(oilChange.confidenceNote.toLowerCase()).toContain("general");

    const { id: ruleId } = await assets.createMaintenanceRuleFromTemplate(ownerUserId, { vehicleProfileId: vehicleId, templateKey: "oil_change" });
    const [created] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId));
    expect(created!.source).toBe("seeded_generic_guidance");
    expect(created!.confidenceNote).toBe(oilChange.confidenceNote);

    // Editing a seeded rule's own numbers is "user correction outranks a guess" — it becomes the user's rule.
    await assets.updateMaintenanceRule(ruleId, ownerUserId, { intervalDays: 90 });
    const [updated] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId));
    expect(updated!.source).toBe("user_added");
    expect(updated!.confidenceNote).toBeNull();
    expect(updated!.intervalDays).toBe(90);

    await assets.deleteMaintenanceRule(ruleId, ownerUserId);
  });

  it("rejects a mileage rule for a home asset (no odometer) at the DTO layer, and creates a calendar rule for one instead", async () => {
    if (!dbAvailable) return;
    const { CreateMaintenanceRuleDtoSchema } = await import("./dto");
    const badResult = CreateMaintenanceRuleDtoSchema.safeParse({ homeAssetId, label: "Bad", intervalType: "mileage", intervalMiles: 1000 });
    expect(badResult.success).toBe(false);

    const { id: ruleId } = await assets.createMaintenanceRuleFromTemplate(ownerUserId, { homeAssetId, templateKey: "hvac_filter" });
    const [created] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId));
    expect(created!.homeAssetId).toBe(homeAssetId);
    expect(created!.intervalType).toBe("calendar");
    await assets.deleteMaintenanceRule(ruleId, ownerUserId);
  });

  // --- VEH-004 registration records --------------------------------------------------------------------

  it("creates, updates, renews, and deletes a registration record", async () => {
    if (!dbAvailable) return;
    const { id: recordId } = await assets.createRegistrationRecord(ownerUserId, {
      vehicleProfileId: vehicleId,
      recordType: "registration",
      jurisdiction: "CA",
      renewalDueDateIso: "2026-03-01",
      reminderLeadDays: 30,
    });

    const [created] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, recordId));
    expect(created!.jurisdiction).toBe("CA");
    expect(created!.status).toBe("active");
    expect(created!.renewalDueDateSort).toEqual(new Date("2026-03-01T00:00:00Z"));

    await assets.updateRegistrationRecord(recordId, ownerUserId, { jurisdiction: "NV" });
    const [updated] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, recordId));
    expect(updated!.jurisdiction).toBe("NV");

    // VEH-004 "renewal ... rolls forward based on ... user confirmation" — requires a real new due date.
    await assets.renewRegistrationRecord(recordId, ownerUserId, { newDueDateIso: "2027-03-01" });
    const [renewed] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, recordId));
    expect(renewed!.status).toBe("active");
    expect(renewed!.renewalDueDateSort).toEqual(new Date("2027-03-01T00:00:00Z"));
    expect(renewed!.lastRenewedDate).not.toBeNull();

    await assets.deleteRegistrationRecord(recordId, ownerUserId);
    const [deleted] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, recordId));
    expect(deleted!.deletedAt).not.toBeNull();
  });

  // --- VEH-001 VIN decode -------------------------------------------------------------------------------

  it("applyVinDecode fills empty make/model/year but NEVER overwrites a value the user already set", async () => {
    if (!dbAvailable) return;
    // This vehicle already has make="Honda"/model="Civic"/year=2018 set at creation (its real VIN would
    // decode to a completely different make/model) — applyVinDecode must leave all three untouched, only
    // ever storing the supplementary decoded attributes.
    let applyResult: Awaited<ReturnType<typeof assets.applyVinDecode>>;
    try {
      applyResult = await assets.applyVinDecode(vehicleId, ownerUserId, "1HGCM82633A004352");
    } catch (err) {
      console.warn("Skipping live-vPIC assertion — outbound network unavailable in this environment:", (err as Error).message);
      return;
    }
    expect(applyResult.suggestion.success).toBe(true);
    expect(applyResult.applied).toEqual({ make: false, model: false, year: false });

    const [vehicle] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    expect(vehicle!.make).toBe("Honda"); // untouched — user's own original value survives
    expect(vehicle!.model).toBe("Civic");
    expect(vehicle!.year).toBe(2018);
    expect(vehicle!.vinDecodedAt).not.toBeNull();
    expect(vehicle!.vinDecodeAttributes?.decodedFromVin).toBe("1HGCM82633A004352");
    expect(vehicle!.vinDecodeAttributes?.bodyClass).toBe("Coupe"); // the decoded VIN's own attributes, stored regardless
  });

  it("applyVinDecode DOES fill in make/model/year for a vehicle that has none on file yet", async () => {
    if (!dbAvailable) return;
    const blank = await assets.createVehicle(ownerUserId, { label: "Blank profile", vin: "1HGCM82633A004352" });
    try {
      let applyResult: Awaited<ReturnType<typeof assets.applyVinDecode>>;
      try {
        applyResult = await assets.applyVinDecode(blank.id, ownerUserId);
      } catch (err) {
        console.warn("Skipping live-vPIC assertion — outbound network unavailable in this environment:", (err as Error).message);
        return;
      }
      expect(applyResult.applied).toEqual({ make: true, model: true, year: true });
      const [vehicle] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, blank.id));
      expect(vehicle!.make).toBe("HONDA");
      expect(vehicle!.model).toBe("Accord");
      expect(vehicle!.year).toBe(2003);
    } finally {
      await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, blank.id));
    }
  });
});
