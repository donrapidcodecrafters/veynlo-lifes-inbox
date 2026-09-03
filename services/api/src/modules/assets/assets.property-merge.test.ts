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
 * §40.1/40.2 "Entity Resolution" gap-close — properties previously had ZERO merge capability. This proves:
 * findPropertyMergeCandidates is exact-normalized-address-only precision-first (a near-miss — a different
 * unit number, or no address at all — is never offered as a candidate), mergeProperties repoints every
 * satellite row (maintenanceRecords/homeAssets/warranties) onto the survivor and records a lineage row (a
 * home asset's own room field, and its own child recallMatches/maintenanceRules rows, travel with it
 * automatically since only `homeAssets.propertyProfileId` itself needs repointing), and unmergeProperties
 * restores them exactly. Mirrors people.merge.test.ts's own shape.
 */
describe("AssetsService — property merge candidates and reversible merge/unmerge", () => {
  let db: Database;
  let sharing: SharingService;
  let assets: AssetsService;

  let ownerUserId: string;
  let otherOwnerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    assets = new AssetsService(db, stubHouseholds, sharing, stubRecallMonitor, new VinDecodeService(new SafeUrlFetcher()), stubQueue);

    try {
      ownerUserId = generateId("user");
      otherOwnerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `prop-merge-owner-${ownerUserId}@example.com`, displayName: "Property Merge Owner" },
        { id: otherOwnerUserId, email: `prop-merge-other-${otherOwnerUserId}@example.com`, displayName: "Other Owner" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AssetsService property merge tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const owned = await db.select({ id: schema.propertyProfiles.id }).from(schema.propertyProfiles).where(eq(schema.propertyProfiles.ownerUserId, ownerUserId));
    for (const { id } of owned) {
      await db.delete(schema.propertyMergeLineage).where(eq(schema.propertyMergeLineage.survivingPropertyId, id));
      await db.delete(schema.propertyMergeLineage).where(eq(schema.propertyMergeLineage.mergedPropertyId, id));
      const homeAssetRows = await db.select({ id: schema.homeAssets.id }).from(schema.homeAssets).where(eq(schema.homeAssets.propertyProfileId, id));
      for (const { id: homeAssetId } of homeAssetRows) {
        await db.delete(schema.recallMatches).where(eq(schema.recallMatches.homeAssetId, homeAssetId));
        await db.delete(schema.maintenanceRules).where(eq(schema.maintenanceRules.homeAssetId, homeAssetId));
      }
      await db.delete(schema.homeAssets).where(eq(schema.homeAssets.propertyProfileId, id));
      await db.delete(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.propertyProfileId, id));
      await db.delete(schema.warranties).where(eq(schema.warranties.propertyProfileId, id));
    }
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.ownerUserId, ownerUserId));
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.ownerUserId, otherOwnerUserId));
    for (const id of [ownerUserId, otherOwnerUserId]) await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  it("finds an exact-normalized-address candidate group, but never a near-miss (different unit, or no address at all)", async () => {
    if (!dbAvailable) return;
    const { id: idA } = await assets.createProperty(ownerUserId, { label: "Home", propertyType: "home", address: "123 Main St. Apt 2" });
    const { id: idB } = await assets.createProperty(ownerUserId, { label: "Duplicate entry", propertyType: "home", address: "123 main st apt 2" }); // same address, different case/punctuation
    const { id: idC } = await assets.createProperty(ownerUserId, { label: "Different unit", propertyType: "home", address: "123 Main St. Apt 3" });
    const { id: idD } = await assets.createProperty(ownerUserId, { label: "No address on file", propertyType: "home" });

    const candidates = await assets.findPropertyMergeCandidates(ownerUserId);
    const group = candidates.find((c) => c.reason === "matching_address" && c.propertyIds.includes(idA));
    expect(group).toBeDefined();
    expect(group!.propertyIds.sort()).toEqual([idA, idB].sort());
    // Near-misses are correctly NOT offered: a different unit number, and a property with no address at
    // all, are never grouped with anything.
    expect(candidates.some((c) => c.propertyIds.includes(idC))).toBe(false);
    expect(candidates.some((c) => c.propertyIds.includes(idD))).toBe(false);
  });

  it("mergeProperties repoints every satellite row onto the survivor and is exactly reversed by unmergeProperties", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await assets.createProperty(ownerUserId, { label: "Survivor House", propertyType: "home", address: "456 Oak Ave" });
    const { id: mergedId } = await assets.createProperty(ownerUserId, { label: "Duplicate House", propertyType: "home", address: "456 Oak Ave" });

    const maintenance = await assets.createMaintenanceRecord(ownerUserId, { description: "Furnace tune-up", propertyProfileId: mergedId });
    const homeAsset = await assets.createHomeAsset(ownerUserId, { propertyProfileId: mergedId, label: "Water heater", room: "Basement" });
    const warrantyId = generateId("warranty");
    await db.insert(schema.warranties).values({
      id: warrantyId,
      ownerUserId,
      propertyProfileId: mergedId,
      productLabel: "Roof warranty",
      expirationDate: { precision: "date", instantUtc: null, date: "2030-01-01", timezone: null, sourceText: null },
    });

    const result = await assets.mergeProperties(survivorId, mergedId, ownerUserId);
    expect(result.repointedMaintenanceRecordCount).toBe(1);
    expect(result.repointedHomeAssetCount).toBe(1);
    expect(result.repointedWarrantyCount).toBe(1);

    const [mergedRow] = await db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, mergedId));
    expect(mergedRow!.mergedIntoPropertyId).toBe(survivorId);
    expect(mergedRow!.deletedAt).toBeNull();
    const list = await assets.listProperties(ownerUserId);
    expect(list.map((p) => p.id)).not.toContain(mergedId);
    expect(list.map((p) => p.id)).toContain(survivorId);

    const [maintenanceAfter] = await db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, maintenance.id));
    expect(maintenanceAfter!.propertyProfileId).toBe(survivorId);
    const [homeAssetAfter] = await db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAsset.id));
    expect(homeAssetAfter!.propertyProfileId).toBe(survivorId);
    // The room field travels with the home asset automatically — no separate repoint needed.
    expect(homeAssetAfter!.room).toBe("Basement");
    const [warrantyAfter] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warrantyAfter!.propertyProfileId).toBe(survivorId);

    // --- Reverse it ---
    const restore = await assets.unmergeProperties(result.lineageId, ownerUserId);
    expect(restore.restoredMaintenanceRecordCount).toBe(1);
    expect(restore.restoredHomeAssetCount).toBe(1);
    expect(restore.restoredWarrantyCount).toBe(1);

    const [mergedRestored] = await db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, mergedId));
    expect(mergedRestored!.mergedIntoPropertyId).toBeNull();
    const listAfterRestore = await assets.listProperties(ownerUserId);
    expect(listAfterRestore.map((p) => p.id)).toContain(mergedId);

    const [maintenanceRestored] = await db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, maintenance.id));
    expect(maintenanceRestored!.propertyProfileId).toBe(mergedId);
    const [homeAssetRestored] = await db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAsset.id));
    expect(homeAssetRestored!.propertyProfileId).toBe(mergedId);
    const [warrantyRestored] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warrantyRestored!.propertyProfileId).toBe(mergedId);

    // Double-unmerge is rejected, not silently re-applied.
    await expect(assets.unmergeProperties(result.lineageId, ownerUserId)).rejects.toMatchObject({ response: { code: "ALREADY_UNMERGED" } });
  });

  it("rejects merging your own property with one you don't own, and rejects merging a property into itself", async () => {
    if (!dbAvailable) return;
    const { id: mineId } = await assets.createProperty(ownerUserId, { label: "Mine", propertyType: "home" });
    const { id: theirsId } = await assets.createProperty(otherOwnerUserId, { label: "Theirs", propertyType: "home" });
    await expect(assets.mergeProperties(mineId, theirsId, ownerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await expect(assets.mergeProperties(mineId, mineId, ownerUserId)).rejects.toMatchObject({ response: { code: "SAME_PROPERTY" } });
  });

  it("unmergeProperties rejects an actor who didn't perform the original merge", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await assets.createProperty(ownerUserId, { label: "Survivor 2", propertyType: "home", address: "789 Elm St" });
    const { id: mergedId } = await assets.createProperty(ownerUserId, { label: "Merged 2", propertyType: "home", address: "789 Elm St" });
    const { lineageId } = await assets.mergeProperties(survivorId, mergedId, ownerUserId);
    await expect(assets.unmergeProperties(lineageId, otherOwnerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });
});
