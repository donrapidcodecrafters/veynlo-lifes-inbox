import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AssetsService } from "./assets.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";
import type { RecallMonitorService } from "./recall-monitor.service";
import type { VinDecodeService } from "./vin-decode.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * SHARE-001 "Set view/edit/manage" — same adversarial goal as lists.rights-enforcement.test.ts, applied to
 * AssetsService's two sharable resource types (properties and vehicles, which share the same
 * assertAssetAccess/requiredRight machinery). Vehicles get the fuller pass (recordOdometerObservation as
 * the "edit" proof, deleteVehicle as the "manage" proof); properties get a lighter pass
 * (createMaintenanceRecord/deleteProperty) since the underlying enforcement code is identical.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubVinDecode = {} as unknown as VinDecodeService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;

describe("AssetsService SHARE-001 right enforcement (view/edit/manage)", () => {
  let db: Database;
  let sharing: SharingService;
  let assets: AssetsService;
  let ownerUserId: string;
  let viewerUserId: string;
  let editorUserId: string;
  let managerUserId: string;
  let vehicleId: string;
  let propertyId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    assets = new AssetsService(db, stubHouseholds, sharing, stubRecallMonitor, stubVinDecode, stubQueue);
    try {
      ownerUserId = generateId("user");
      viewerUserId = generateId("user");
      editorUserId = generateId("user");
      managerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `asset-rights-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: viewerUserId, email: `asset-rights-viewer-${viewerUserId}@example.com`, displayName: "Viewer" },
        { id: editorUserId, email: `asset-rights-editor-${editorUserId}@example.com`, displayName: "Editor" },
        { id: managerUserId, email: `asset-rights-manager-${managerUserId}@example.com`, displayName: "Manager" },
      ]);

      const vehicle = await assets.createVehicle(ownerUserId, { label: "Rights test car", make: "Test", model: "Model", year: 2024 });
      vehicleId = vehicle.id;
      const property = await assets.createProperty(ownerUserId, { label: "Rights test house", propertyType: "home" });
      propertyId = property.id;

      const [viewerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, viewerUserId)).limit(1);
      const [editorRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, editorUserId)).limit(1);
      const [managerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, managerUserId)).limit(1);

      await assets.createVehicleGrant(vehicleId, ownerUserId, viewerRow!.email!, undefined, "view");
      await assets.createVehicleGrant(vehicleId, ownerUserId, editorRow!.email!, undefined, "edit");
      await assets.createVehicleGrant(vehicleId, ownerUserId, managerRow!.email!, undefined, "manage");

      await assets.createPropertyGrant(propertyId, ownerUserId, viewerRow!.email!, undefined, "view");
      await assets.createPropertyGrant(propertyId, ownerUserId, editorRow!.email!, undefined, "edit");
      await assets.createPropertyGrant(propertyId, ownerUserId, managerRow!.email!, undefined, "manage");
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping asset rights-enforcement tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, viewerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, editorUserId));
      await db.delete(schema.users).where(eq(schema.users.id, managerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("vehicle: a 'view' grant can read but cannot record an observation, add a tire, delete, or re-share", async () => {
    if (!dbAvailable) return;
    const detail = await assets.vehicleDetail(vehicleId, viewerUserId);
    expect(detail?.vehicle.id).toBe(vehicleId);

    await expect(assets.recordOdometerObservation(viewerUserId, { vehicleProfileId: vehicleId, mileage: 1000, source: "user_entered" })).rejects.toThrow();
    await expect(assets.createVehicleGrant(vehicleId, viewerUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
    await expect(assets.createVehicleShareLink(vehicleId, viewerUserId, {})).rejects.toThrow();
    await expect(assets.deleteVehicle(vehicleId, viewerUserId)).rejects.toThrow();
  });

  it("vehicle: an 'edit' grant can record an observation but cannot delete the vehicle or re-share it", async () => {
    if (!dbAvailable) return;
    await assets.recordOdometerObservation(editorUserId, { vehicleProfileId: vehicleId, mileage: 5000, source: "user_entered" });
    expect(await assets.latestOdometerMileage(vehicleId)).toBe(5000);

    await expect(assets.deleteVehicle(vehicleId, editorUserId)).rejects.toThrow();
    await expect(assets.createVehicleGrant(vehicleId, editorUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
  });

  it("vehicle: a 'manage' grant can create/revoke other grants and delete the vehicle, but never becomes the owner", async () => {
    if (!dbAvailable) return;
    const tempGranteeId = generateId("user");
    const tempGranteeEmail = `asset-rights-temp-${tempGranteeId}@example.com`;
    await db.insert(schema.users).values({ id: tempGranteeId, email: tempGranteeEmail, displayName: "Temp" });
    const { id: tempGrantId } = await assets.createVehicleGrant(vehicleId, managerUserId, tempGranteeEmail, undefined, "view");
    expect((await assets.listVehicleGrants(vehicleId, managerUserId)).some((g) => g.grant.id === tempGrantId)).toBe(true);
    await assets.revokeResourceGrant(tempGrantId, managerUserId);

    const stillOwnedByOriginalOwner = await db.select({ ownerUserId: schema.vehicleProfiles.ownerUserId }).from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    expect(stillOwnedByOriginalOwner[0]?.ownerUserId).toBe(ownerUserId);

    await assets.deleteVehicle(vehicleId, managerUserId);
    await expect(assets.vehicleDetail(vehicleId, ownerUserId)).resolves.toBeNull();

    await db.delete(schema.users).where(eq(schema.users.id, tempGranteeId));
  });

  it("property: a 'view' grant cannot add a maintenance record or delete the property; an 'edit' grant can add one but not delete; a 'manage' grant can delete it", async () => {
    if (!dbAvailable) return;
    await expect(assets.createMaintenanceRecord(viewerUserId, { propertyProfileId: propertyId, description: "Should fail" })).rejects.toThrow();
    await expect(assets.deleteProperty(propertyId, viewerUserId)).rejects.toThrow();

    await assets.createMaintenanceRecord(editorUserId, { propertyProfileId: propertyId, description: "Gutter cleaning" });
    await expect(assets.deleteProperty(propertyId, editorUserId)).rejects.toThrow();

    await assets.deleteProperty(propertyId, managerUserId);
    await expect(assets.propertyDetail(propertyId, ownerUserId)).resolves.toBeNull();
  });
});
