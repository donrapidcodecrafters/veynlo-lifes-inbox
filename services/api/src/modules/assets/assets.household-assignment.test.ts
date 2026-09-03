import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AssetsService } from "./assets.service";
import { SharingService } from "../sharing/sharing.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { EmergencyBinderService } from "../emergency-binder/emergency-binder.service";
import type { IdentityService } from "../identity/identity.service";
import type { RecallMonitorService } from "./recall-monitor.service";
import type { VinDecodeService } from "./vin-decode.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubVinDecode = {} as unknown as VinDecodeService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;
// EmergencyBinderService's step-up check is exercised on its own in emergency-binder.household-scope.test.ts
// — this file only needs getBinder() to run at all, see pets.household-scope.test.ts's identical stub.
const stubIdentity = { verifyStepUpPassword: async () => {} } as unknown as IdentityService;

/**
 * Gap-close, confirmed live: a vehicle/property profile had NO edit endpoint at all before this pass — only
 * create/delete existed — so `householdId` (already accepted by createProperty/createVehicle's own DTOs)
 * could never be assigned or changed after the fact. The concrete, observable consequence: a vehicle/
 * property added while private (or added before its owner joined a household) could never show up in that
 * household's Emergency Binder, since EmergencyBinderService.getBinder queries `vehicleProfiles`/
 * `propertyProfiles` by `householdId` alone (see that service's own doc comment). This proves the full loop
 * end to end against the REAL HouseholdService/EmergencyBinderService — not just that AssetsService.
 * updateProperty/updateVehicle write the column — mirroring pets.household-scope.test.ts's identical
 * "assigning householdId via update() makes a previously-private X show up in the emergency binder" case.
 */
describe("AssetsService — household assignment via update (vehicles & properties)", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let assets: AssetsService;
  let binder: EmergencyBinderService;

  let ownerUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let otherHouseholdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    assets = new AssetsService(db, households, sharing, stubRecallMonitor, stubVinDecode, stubQueue);
    binder = new EmergencyBinderService(db, households, stubIdentity);

    try {
      ownerUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");
      otherHouseholdId = generateId("household");

      await db.insert(schema.users).values([
        { id: ownerUserId, email: `asset-hh-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: outsiderUserId, email: `asset-hh-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values([
        { id: householdId, name: "Assets Test Household", billingOwnerUserId: ownerUserId },
        { id: otherHouseholdId, name: "Someone Else's Household", billingOwnerUserId: outsiderUserId },
      ]);
      await db.insert(schema.householdMemberships).values({
        id: generateId("membership"),
        householdId,
        userId: ownerUserId,
        role: "household_owner",
        status: "active",
        joinedAt: new Date(),
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping assets household-assignment tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, otherHouseholdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
    }
  });

  it("assigning householdId via updateVehicle() makes a previously-private vehicle show up in the emergency binder; unassigning removes it again", async () => {
    if (!dbAvailable) return;
    const { id: vehicleId } = await assets.createVehicle(ownerUserId, { label: "Private Car", make: "Test", model: "Model", year: 2022 });
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).vehicles.some((v) => v.id === vehicleId)).toBe(false);

    await assets.updateVehicle(vehicleId, ownerUserId, { householdId });
    const [afterAssign] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    expect(afterAssign?.householdId).toBe(householdId);
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).vehicles.some((v) => v.id === vehicleId)).toBe(true);

    // Can't assign into a household the caller isn't an active member of.
    await expect(assets.updateVehicle(vehicleId, ownerUserId, { householdId: otherHouseholdId })).rejects.toThrow();

    // Explicit null makes it private again — removed from the binder.
    await assets.updateVehicle(vehicleId, ownerUserId, { householdId: null });
    const [afterUnassign] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    expect(afterUnassign?.householdId).toBeNull();
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).vehicles.some((v) => v.id === vehicleId)).toBe(false);

    // A non-owner outsider with no access at all can't update it.
    await expect(assets.updateVehicle(vehicleId, outsiderUserId, { householdId })).rejects.toThrow();

    // Ordinary fields (not just householdId) are editable too — the endpoint didn't exist at all before.
    await assets.updateVehicle(vehicleId, ownerUserId, { label: "Renamed Car", make: "Toyota", model: "Corolla", year: 2023 });
    const [renamed] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    expect(renamed?.label).toBe("Renamed Car");
    expect(renamed?.make).toBe("Toyota");

    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
  });

  it("assigning householdId via updateProperty() makes a previously-private property show up in the emergency binder; unassigning removes it again", async () => {
    if (!dbAvailable) return;
    const { id: propertyId } = await assets.createProperty(ownerUserId, { label: "Private House", propertyType: "home", address: "1 Test St" });
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).properties.some((p) => p.id === propertyId)).toBe(false);

    await assets.updateProperty(propertyId, ownerUserId, { householdId });
    const [afterAssign] = await db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
    expect(afterAssign?.householdId).toBe(householdId);
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).properties.some((p) => p.id === propertyId)).toBe(true);

    // Can't assign into a household the caller isn't an active member of.
    await expect(assets.updateProperty(propertyId, ownerUserId, { householdId: otherHouseholdId })).rejects.toThrow();

    // Explicit null makes it private again — removed from the binder.
    await assets.updateProperty(propertyId, ownerUserId, { householdId: null });
    const [afterUnassign] = await db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
    expect(afterUnassign?.householdId).toBeNull();
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).properties.some((p) => p.id === propertyId)).toBe(false);

    // A non-owner outsider with no access at all can't update it.
    await expect(assets.updateProperty(propertyId, outsiderUserId, { householdId })).rejects.toThrow();

    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
  });
});
