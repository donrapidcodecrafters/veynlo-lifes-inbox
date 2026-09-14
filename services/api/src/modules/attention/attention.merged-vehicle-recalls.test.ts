import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, ne } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo_audit";

/**
 * Merging a duplicate vehicle sets `mergedIntoVehicleId` and never hard-deletes the row — see
 * `assets.service.ts`'s mergeVehicles doc comment. `RecallMonitorService.scanAll` knows this and excludes
 * merged-away and soft-deleted vehicles when it looks for new recalls, saying so in its own comment:
 * "any resulting recall match would be silently orphaned".
 *
 * `AttentionService`'s open-recall read had no equivalent exclusion. So a merged-away duplicate's
 * PRE-EXISTING `recall_matches` rows kept filing attention items on every scan tick, under the name of a
 * vehicle the user believes they already merged away and which no list screen shows. Found by the Mac
 * session against a database where it had genuinely accumulated; latent in the tower's seed only because
 * its one merged vehicle happens to have no open matches.
 *
 * This asserts the query's contract directly rather than running the whole hourly scan: the scan files
 * items through `fileIfNew` for whatever this read returns, so what the read excludes is the whole
 * question.
 */
describe("open recalls exclude merged-away and deleted subjects", () => {
  let db: Database;
  let dbAvailable = true;
  let setupError: Error | null = null;

  const userId = generateId("user");
  const liveVehicleId = generateId("vehicle");
  const mergedVehicleId = generateId("vehicle");
  const deletedVehicleId = generateId("vehicle");
  const liveAssetId = generateId("homeAsset");
  const deletedAssetId = generateId("homeAsset");
  const propertyId = generateId("property");

  const recallOn = (vehicleId: string | null, homeAssetId: string | null) => ({
    id: generateId("recallMatch"),
    ownerUserId: userId,
    vehicleProfileId: vehicleId,
    homeAssetId,
    source: "nhtsa",
    campaignNumber: `C-${generateId("recallMatch").slice(-8)}`,
    summary: "Brake line may corrode",
    component: "Brakes",
    status: "potential" as const,
    checkedAt: new Date(),
  });

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      await db.insert(schema.users).values({ id: userId, email: `recall-${userId}@example.com`, displayName: "Recall Test" });
    } catch {
      dbAvailable = false;
      return;
    }
    try {
      await db.insert(schema.vehicleProfiles).values({ id: liveVehicleId, ownerUserId: userId, label: "Live Civic" });
      await db.insert(schema.vehicleProfiles).values({ id: mergedVehicleId, ownerUserId: userId, label: "Duplicate Civic", mergedIntoVehicleId: liveVehicleId });
      await db.insert(schema.vehicleProfiles).values({ id: deletedVehicleId, ownerUserId: userId, label: "Deleted Civic", deletedAt: new Date() });
      await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId: userId, label: "House" });
      await db.insert(schema.homeAssets).values({ id: liveAssetId, ownerUserId: userId, propertyProfileId: propertyId, label: "Live Dishwasher" });
      await db.insert(schema.homeAssets).values({ id: deletedAssetId, ownerUserId: userId, propertyProfileId: propertyId, label: "Deleted Dishwasher", deletedAt: new Date() });

      await db.insert(schema.recallMatches).values(recallOn(liveVehicleId, null));
      await db.insert(schema.recallMatches).values(recallOn(mergedVehicleId, null));
      await db.insert(schema.recallMatches).values(recallOn(deletedVehicleId, null));
      await db.insert(schema.recallMatches).values(recallOn(null, liveAssetId));
      await db.insert(schema.recallMatches).values(recallOn(null, deletedAssetId));
    } catch (error) {
      setupError = error as Error;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  /** The production query, verbatim. */
  const openRecalls = () =>
    db
      .select({ recall: schema.recallMatches, vehicle: schema.vehicleProfiles, homeAsset: schema.homeAssets })
      .from(schema.recallMatches)
      .leftJoin(schema.vehicleProfiles, eq(schema.vehicleProfiles.id, schema.recallMatches.vehicleProfileId))
      .leftJoin(schema.homeAssets, eq(schema.homeAssets.id, schema.recallMatches.homeAssetId))
      .where(
        and(
          ne(schema.recallMatches.status, "closed_or_repaired"),
          isNull(schema.vehicleProfiles.deletedAt),
          isNull(schema.vehicleProfiles.mergedIntoVehicleId),
          isNull(schema.homeAssets.deletedAt),
          eq(schema.recallMatches.ownerUserId, userId),
        ),
      );

  it("set the fixture up", () => {
    if (!dbAvailable) return;
    expect(setupError, setupError?.message).toBeNull();
  });

  it("returns the live vehicle and the live home asset, and nothing else", async () => {
    if (!dbAvailable || setupError) return;
    const rows = await openRecalls();
    const labels = rows.map((r) => r.vehicle?.label ?? r.homeAsset?.label).sort();
    expect(labels).toEqual(["Live Civic", "Live Dishwasher"]);
  });

  it("does not keep nagging about a vehicle the user merged away", async () => {
    if (!dbAvailable || setupError) return;
    const rows = await openRecalls();
    expect(rows.map((r) => r.vehicle?.id)).not.toContain(mergedVehicleId);
    // And the row is still there — merging never hard-deletes, which is exactly why the read has to filter.
    const [stillPresent] = await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, mergedVehicleId));
    expect(stillPresent?.mergedIntoVehicleId).toBe(liveVehicleId);
    const matchesStillExist = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, mergedVehicleId));
    expect(matchesStillExist.length, "the match row survives; only the notification is suppressed").toBe(1);
  });

  it("excludes a soft-deleted vehicle and a soft-deleted home asset too", async () => {
    if (!dbAvailable || setupError) return;
    const rows = await openRecalls();
    expect(rows.map((r) => r.vehicle?.id)).not.toContain(deletedVehicleId);
    expect(rows.map((r) => r.homeAsset?.id)).not.toContain(deletedAssetId);
  });

  it("the exclusions do not swallow the other subject type", async () => {
    if (!dbAvailable || setupError) return;
    // A vehicle recall has a null homeAssetId, so its home-asset join yields null — isNull() must pass it
    // rather than filter it out. Getting this wrong would silently drop one whole category of recall, which
    // is a worse bug than the one being fixed.
    const rows = await openRecalls();
    expect(rows.some((r) => r.vehicle?.id === liveVehicleId), "vehicle recall survived the homeAssets filter").toBe(true);
    expect(rows.some((r) => r.homeAsset?.id === liveAssetId), "home-asset recall survived the vehicle filters").toBe(true);
  });

  it("would have returned all five without the exclusions, which is the bug", async () => {
    if (!dbAvailable || setupError) return;
    // The pre-fix query, kept so the test states what was actually wrong rather than only what is right.
    const unfiltered = await db
      .select({ id: schema.recallMatches.id })
      .from(schema.recallMatches)
      .leftJoin(schema.vehicleProfiles, eq(schema.vehicleProfiles.id, schema.recallMatches.vehicleProfileId))
      .leftJoin(schema.homeAssets, eq(schema.homeAssets.id, schema.recallMatches.homeAssetId))
      .where(and(ne(schema.recallMatches.status, "closed_or_repaired"), eq(schema.recallMatches.ownerUserId, userId)));
    expect(unfiltered).toHaveLength(5);
    expect((await openRecalls()).length).toBe(2);
  });
});
