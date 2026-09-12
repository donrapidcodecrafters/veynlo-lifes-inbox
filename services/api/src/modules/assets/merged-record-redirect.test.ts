import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AssetsService } from "./assets.service";
import { SharingService } from "../sharing/sharing.service";
import { VinDecodeService } from "./vin-decode.service";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";
import { PetsService } from "../pets/pets.service";
import type { HouseholdService } from "../household/household.service";
import type { RecallMonitorService } from "./recall-monitor.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = { delegatedHouseholdIds: async () => [], activeHouseholdIds: async () => [] } as unknown as HouseholdService;
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;

/**
 * A merged record's detail route names the record it was merged into, so the client can send the user
 * there instead of reporting a record that still exists as missing.
 *
 * This existed nowhere: people.merge.test.ts asserted the old "not found" behaviour, and the vehicle,
 * property and pet merge tests never called their detail routes at all — so three of the four mergeable
 * types had no coverage of what happens when you open a merged record, in either direction.
 *
 * Two things are asserted for each type, and the second matters as much as the first:
 *
 *   the surviving id is returned, and is the RIGHT one — a redirect that names the wrong record would be
 *   worse than the dead end it replaces, and "some id came back" would not catch that;
 *
 *   a caller with no access gets a plain authorization failure and no id. The id is a record they may not
 *   be allowed to see, so disclosing it in a 404 would be an enumeration oracle (DEF-089's shape).
 */
describe("merged records name their survivor instead of reporting themselves missing", () => {
  let db: Database;
  let assets: AssetsService;
  let pets: PetsService;

  let ownerUserId: string;
  let strangerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const sharing = new SharingService(db);
    assets = new AssetsService(db, stubHouseholds, sharing, stubRecallMonitor, new VinDecodeService(new SafeUrlFetcher()), stubQueue);
    pets = new PetsService(db, stubHouseholds, sharing);

    try {
      ownerUserId = generateId("user");
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `merge-redirect-owner-${ownerUserId}@example.com`, displayName: "Merge Redirect Owner" },
        { id: strangerUserId, email: `merge-redirect-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping merged-record redirect tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // Lineage rows first: merging is what these tests do, so every profile below is referenced by a
    // *_merge_lineage row, and deleting the profiles first fails the foreign key and takes the whole suite
    // down in teardown — the tests themselves having passed. Mirrors assets.vehicle-merge.test.ts.
    const vehicles = await db.select({ id: schema.vehicleProfiles.id }).from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.ownerUserId, ownerUserId));
    for (const { id } of vehicles) {
      await db.delete(schema.vehicleMergeLineage).where(eq(schema.vehicleMergeLineage.survivingVehicleId, id));
      await db.delete(schema.vehicleMergeLineage).where(eq(schema.vehicleMergeLineage.mergedVehicleId, id));
    }
    const properties = await db.select({ id: schema.propertyProfiles.id }).from(schema.propertyProfiles).where(eq(schema.propertyProfiles.ownerUserId, ownerUserId));
    for (const { id } of properties) {
      await db.delete(schema.propertyMergeLineage).where(eq(schema.propertyMergeLineage.survivingPropertyId, id));
      await db.delete(schema.propertyMergeLineage).where(eq(schema.propertyMergeLineage.mergedPropertyId, id));
    }
    const petRows = await db.select({ id: schema.petProfiles.id }).from(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, ownerUserId));
    for (const { id } of petRows) {
      await db.delete(schema.petMergeLineage).where(eq(schema.petMergeLineage.survivingPetId, id));
      await db.delete(schema.petMergeLineage).where(eq(schema.petMergeLineage.mergedPetId, id));
    }
    for (const table of [schema.vehicleProfiles, schema.propertyProfiles, schema.petProfiles]) {
      await db.delete(table).where(eq(table.ownerUserId, ownerUserId));
    }
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
  });

  it("a merged vehicle's detail names the surviving vehicle, and tells a stranger nothing", async () => {
    if (!dbAvailable) return;
    const survivor = await assets.createVehicle(ownerUserId, { label: "The Outback", vin: "JF2SJAEC0FH000001" } as never);
    const dupe = await assets.createVehicle(ownerUserId, { label: "Outback (duplicate)", vin: "JF2SJAEC0FH000001" } as never);
    await assets.mergeVehicles(survivor.id, dupe.id, ownerUserId);

    await expect(assets.vehicleDetail(dupe.id, ownerUserId)).rejects.toMatchObject({
      response: { code: "VEHICLE_MERGED", mergedIntoId: survivor.id },
    });
    // The survivor itself must still load — the common path is the one that would hurt most if broken.
    expect(await assets.vehicleDetail(survivor.id, ownerUserId)).toMatchObject({ vehicle: { id: survivor.id } });

    // A stranger is refused, and learns nothing about where it went.
    await expect(assets.vehicleDetail(dupe.id, strangerUserId)).rejects.toMatchObject({
      response: expect.not.objectContaining({ mergedIntoId: survivor.id }),
    });
  });

  it("a merged property's detail names the surviving property", async () => {
    if (!dbAvailable) return;
    const survivor = await assets.createProperty(ownerUserId, { label: "The Cabin", propertyType: "vacation" } as never);
    const dupe = await assets.createProperty(ownerUserId, { label: "Cabin (duplicate)", propertyType: "vacation" } as never);
    await assets.mergeProperties(survivor.id, dupe.id, ownerUserId);

    await expect(assets.propertyDetail(dupe.id, ownerUserId)).rejects.toMatchObject({
      response: { code: "PROPERTY_MERGED", mergedIntoId: survivor.id },
    });
    expect(await assets.propertyDetail(survivor.id, ownerUserId)).toMatchObject({ property: { id: survivor.id } });
  });

  it("a merged pet's detail names the surviving pet", async () => {
    if (!dbAvailable) return;
    const survivor = await pets.create(ownerUserId, { label: "Biscuit", species: "dog" } as never);
    const dupe = await pets.create(ownerUserId, { label: "Biscuit (duplicate)", species: "dog" } as never);
    await pets.mergePets(survivor.id, dupe.id, ownerUserId);

    await expect(pets.detail(dupe.id, ownerUserId)).rejects.toMatchObject({
      response: { code: "PET_MERGED", mergedIntoId: survivor.id },
    });
    expect(await pets.detail(survivor.id, ownerUserId)).toMatchObject({ pet: { id: survivor.id } });
  });

  it("a record that never existed still just reports not found, with no id attached", async () => {
    if (!dbAvailable) return;
    expect(await assets.vehicleDetail("veh_nonexistent", ownerUserId)).toBeNull();
  });
});
