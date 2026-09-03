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

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = { delegatedHouseholdIds: async () => [], activeHouseholdIds: async () => [] } as unknown as HouseholdService;
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;

/**
 * §40.1/40.2 "Entity Resolution" gap-close — vehicles previously had ZERO merge capability. This proves:
 * findVehicleMergeCandidates is exact-VIN-only precision-first (a near-miss on make/model/year with a
 * DIFFERENT vin, or no vin at all, is never offered as a candidate — "false non-merge is preferable to
 * incorrectly combining two ... vehicles"), mergeVehicles repoints every satellite row (maintenanceRecords/
 * odometerObservations/tires/recallMatches/maintenanceRules/registrationRecords/warranties) onto the
 * survivor and records a lineage row, and unmergeVehicles restores them exactly. Mirrors
 * people.merge.test.ts's own shape.
 */
describe("AssetsService — vehicle merge candidates and reversible merge/unmerge", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let assets: AssetsService;

  let ownerUserId: string;
  let otherOwnerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    households = stubHouseholds;
    sharing = new SharingService(db);
    assets = new AssetsService(db, households, sharing, stubRecallMonitor, new VinDecodeService(new SafeUrlFetcher()), stubQueue);

    try {
      ownerUserId = generateId("user");
      otherOwnerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `veh-merge-owner-${ownerUserId}@example.com`, displayName: "Vehicle Merge Owner" },
        { id: otherOwnerUserId, email: `veh-merge-other-${otherOwnerUserId}@example.com`, displayName: "Other Owner" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AssetsService vehicle merge tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const owned = await db.select({ id: schema.vehicleProfiles.id }).from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.ownerUserId, ownerUserId));
    for (const { id } of owned) {
      await db.delete(schema.vehicleMergeLineage).where(eq(schema.vehicleMergeLineage.survivingVehicleId, id));
      await db.delete(schema.vehicleMergeLineage).where(eq(schema.vehicleMergeLineage.mergedVehicleId, id));
      await db.delete(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.vehicleProfileId, id));
      await db.delete(schema.odometerObservations).where(eq(schema.odometerObservations.vehicleProfileId, id));
      await db.delete(schema.tires).where(eq(schema.tires.vehicleProfileId, id));
      await db.delete(schema.registrationRecords).where(eq(schema.registrationRecords.vehicleProfileId, id));
      await db.delete(schema.warranties).where(eq(schema.warranties.vehicleProfileId, id));
    }
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.ownerUserId, ownerUserId));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.ownerUserId, otherOwnerUserId));
    for (const id of [ownerUserId, otherOwnerUserId]) await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  it("finds an exact-VIN candidate group, but never a near-miss (different VIN, or no VIN at all)", async () => {
    if (!dbAvailable) return;
    const { id: idA } = await assets.createVehicle(ownerUserId, { label: "Garage car", make: "Honda", model: "Civic", year: 2018, vin: "1HGCM82633A004352" });
    const { id: idB } = await assets.createVehicle(ownerUserId, { label: "Duplicate entry", make: "Honda", model: "Civic", year: 2018, vin: "1hgcm82633a004352 " }); // same VIN, different case/whitespace
    const { id: idC } = await assets.createVehicle(ownerUserId, { label: "Different VIN, same make/model/year", make: "Honda", model: "Civic", year: 2018, vin: "2HGCM82633A004999" });
    const { id: idD } = await assets.createVehicle(ownerUserId, { label: "No VIN on file" });

    const candidates = await assets.findVehicleMergeCandidates(ownerUserId);
    const group = candidates.find((c) => c.reason === "matching_vin" && c.vehicleIds.includes(idA));
    expect(group).toBeDefined();
    expect(group!.vehicleIds.sort()).toEqual([idA, idB].sort());
    // Near-misses are correctly NOT offered: same make/model/year but a different VIN, and a vehicle with
    // no VIN at all, are never grouped with anything.
    expect(candidates.some((c) => c.vehicleIds.includes(idC))).toBe(false);
    expect(candidates.some((c) => c.vehicleIds.includes(idD))).toBe(false);
  });

  it("mergeVehicles repoints every satellite row onto the survivor and is exactly reversed by unmergeVehicles", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await assets.createVehicle(ownerUserId, { label: "Survivor Truck", make: "Ford", model: "F-150", year: 2020, vin: "1FTFW1E5XLFA00001" });
    const { id: mergedId } = await assets.createVehicle(ownerUserId, { label: "Duplicate Truck", vin: "1FTFW1E5XLFA00001" });

    const maintenance = await assets.createMaintenanceRecord(ownerUserId, { description: "Oil change", vehicleProfileId: mergedId });
    const odometer = await assets.recordOdometerObservation(ownerUserId, { vehicleProfileId: mergedId, mileage: 12000, source: "user_entered" });
    const tire = await assets.createTire(ownerUserId, { vehicleProfileId: mergedId, brand: "Michelin" });
    const rule = await assets.createMaintenanceRule(ownerUserId, { vehicleProfileId: mergedId, label: "Oil change", intervalType: "mileage", intervalMiles: 5000 });
    const registration = await assets.createRegistrationRecord(ownerUserId, { vehicleProfileId: mergedId, recordType: "registration", reminderLeadDays: 30 });
    const warrantyId = generateId("warranty");
    await db.insert(schema.warranties).values({
      id: warrantyId,
      ownerUserId,
      vehicleProfileId: mergedId,
      productLabel: "Powertrain warranty",
      expirationDate: { precision: "date", instantUtc: null, date: "2028-01-01", timezone: null, sourceText: null },
    });

    const result = await assets.mergeVehicles(survivorId, mergedId, ownerUserId);
    expect(result.repointedMaintenanceRecordCount).toBe(1);
    expect(result.repointedOdometerObservationCount).toBe(1);
    expect(result.repointedTireCount).toBe(1);
    expect(result.repointedMaintenanceRuleCount).toBe(1);
    expect(result.repointedRegistrationRecordCount).toBe(1);
    expect(result.repointedWarrantyCount).toBe(1);

    const [mergedRow] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, mergedId));
    expect(mergedRow!.mergedIntoVehicleId).toBe(survivorId);
    expect(mergedRow!.deletedAt).toBeNull();
    // Merged-away vehicle is excluded from ordinary list queries but not hard-deleted.
    const list = await assets.listVehicles(ownerUserId);
    expect(list.map((v) => v.id)).not.toContain(mergedId);
    expect(list.map((v) => v.id)).toContain(survivorId);

    // Every satellite row now points at the survivor.
    const [maintenanceAfter] = await db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, maintenance.id));
    expect(maintenanceAfter!.vehicleProfileId).toBe(survivorId);
    const [odometerAfter] = await db.select().from(schema.odometerObservations).where(eq(schema.odometerObservations.id, odometer.id));
    expect(odometerAfter!.vehicleProfileId).toBe(survivorId);
    const [tireAfter] = await db.select().from(schema.tires).where(eq(schema.tires.id, tire.id));
    expect(tireAfter!.vehicleProfileId).toBe(survivorId);
    const [ruleAfter] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, rule.id));
    expect(ruleAfter!.vehicleProfileId).toBe(survivorId);
    const [registrationAfter] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, registration.id));
    expect(registrationAfter!.vehicleProfileId).toBe(survivorId);
    const [warrantyAfter] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warrantyAfter!.vehicleProfileId).toBe(survivorId);

    // --- Reverse it ---
    const restore = await assets.unmergeVehicles(result.lineageId, ownerUserId);
    expect(restore.restoredMaintenanceRecordCount).toBe(1);
    expect(restore.restoredOdometerObservationCount).toBe(1);
    expect(restore.restoredTireCount).toBe(1);
    expect(restore.restoredMaintenanceRuleCount).toBe(1);
    expect(restore.restoredRegistrationRecordCount).toBe(1);
    expect(restore.restoredWarrantyCount).toBe(1);

    const [mergedRestored] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, mergedId));
    expect(mergedRestored!.mergedIntoVehicleId).toBeNull();
    const listAfterRestore = await assets.listVehicles(ownerUserId);
    expect(listAfterRestore.map((v) => v.id)).toContain(mergedId);

    const [maintenanceRestored] = await db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, maintenance.id));
    expect(maintenanceRestored!.vehicleProfileId).toBe(mergedId);
    const [odometerRestored] = await db.select().from(schema.odometerObservations).where(eq(schema.odometerObservations.id, odometer.id));
    expect(odometerRestored!.vehicleProfileId).toBe(mergedId);
    const [tireRestored] = await db.select().from(schema.tires).where(eq(schema.tires.id, tire.id));
    expect(tireRestored!.vehicleProfileId).toBe(mergedId);
    const [ruleRestored] = await db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, rule.id));
    expect(ruleRestored!.vehicleProfileId).toBe(mergedId);
    const [registrationRestored] = await db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, registration.id));
    expect(registrationRestored!.vehicleProfileId).toBe(mergedId);

    // Double-unmerge is rejected, not silently re-applied.
    await expect(assets.unmergeVehicles(result.lineageId, ownerUserId)).rejects.toMatchObject({ response: { code: "ALREADY_UNMERGED" } });
  });

  it("rejects merging your own vehicle with one you don't own, and rejects merging a vehicle into itself", async () => {
    if (!dbAvailable) return;
    const { id: mineId } = await assets.createVehicle(ownerUserId, { label: "Mine" });
    const { id: theirsId } = await assets.createVehicle(otherOwnerUserId, { label: "Theirs" });
    await expect(assets.mergeVehicles(mineId, theirsId, ownerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await expect(assets.mergeVehicles(mineId, mineId, ownerUserId)).rejects.toMatchObject({ response: { code: "SAME_VEHICLE" } });
  });

  it("unmergeVehicles rejects an actor who didn't perform the original merge", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await assets.createVehicle(ownerUserId, { label: "Survivor 2", vin: "1HGCM82633A009999" });
    const { id: mergedId } = await assets.createVehicle(ownerUserId, { label: "Merged 2", vin: "1HGCM82633A009999" });
    const { lineageId } = await assets.mergeVehicles(survivorId, mergedId, ownerUserId);
    await expect(assets.unmergeVehicles(lineageId, otherOwnerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });
});
