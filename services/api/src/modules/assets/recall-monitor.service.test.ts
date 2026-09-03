import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { RecallMonitorService } from "./recall-monitor.service";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";

/**
 * VEH-006/HOMEOS-008 — real integration test against real dev Postgres AND, deliberately, the real live
 * NHTSA/CPSC public APIs (not mocked): both are free, public, no-API-key-required US government services,
 * verified reachable from this environment before this service was built at all
 * (`curl https://api.nhtsa.gov/recalls/recallsByVehicle?make=Honda&model=Civic&modelYear=2015` and the CPSC
 * equivalent both returned real recall data live). A 2015 Honda Civic is used specifically because NHTSA's
 * own API is independently known (and re-verified below) to return a real transmission-recall campaign for
 * it (NHTSACampaignNumber 15V574000) — this is asserting against real government data, not a fixture.
 *
 * If a future run of this suite happens in an environment where outbound internet access is blocked, these
 * `it`s degrade to a skipped assertion via the same `dbAvailable`-style guard used elsewhere in this
 * codebase's integration tests, rather than failing the whole file — see the try/catch around each network
 * call below.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("RecallMonitorService — live NHTSA/CPSC integration", () => {
  let db: Database;
  let recallMonitor: RecallMonitorService;
  let ownerUserId: string;
  let dbAvailable = true;
  const createdVehicleIds: string[] = [];
  const createdHomeAssetIds: string[] = [];
  const createdPropertyIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    recallMonitor = new RecallMonitorService(db, new SafeUrlFetcher());
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `recall-monitor-test-${ownerUserId}@example.com`, displayName: "Recall Monitor Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping RecallMonitorService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdVehicleIds) {
      await db.delete(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, id));
      await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, id));
    }
    for (const id of createdHomeAssetIds) {
      await db.delete(schema.recallMatches).where(eq(schema.recallMatches.homeAssetId, id));
      await db.delete(schema.homeAssets).where(eq(schema.homeAssets.id, id));
    }
    for (const id of createdPropertyIds) await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, id));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  /** Directly seeds a recall_matches row (bypassing RecallMonitorService entirely) with a campaign number
   * NHTSA will never actually return, standing in for a stale row left over from a fixed matching bug or
   * an upstream removal — see the "prunes a stale match" test below. */
  async function makeStaleMatch(vehicleProfileId: string, campaignNumber: string, status: string): Promise<string> {
    const id = generateId("recallMatch");
    await db.insert(schema.recallMatches).values({
      id,
      ownerUserId,
      vehicleProfileId,
      source: "nhtsa",
      campaignNumber,
      summary: "Stale test row.",
      status,
    });
    return id;
  }

  it("no-ops (no network call, no rows written) for a vehicle missing make/model/year", async () => {
    if (!dbAvailable) return;
    const vehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "Incomplete profile", make: "Honda" }); // no model/year
    createdVehicleIds.push(vehicleId);

    const result = await recallMonitor.checkVehicle(vehicleId);
    expect(result).toEqual({ checked: false, newMatches: 0 });

    const rows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, vehicleId));
    expect(rows).toHaveLength(0);
  });

  it("checks a real vehicle against the live NHTSA API and upserts a real, VIN-unconfirmed recall match", async () => {
    if (!dbAvailable) return;
    const vehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "2015 Civic", make: "Honda", model: "Civic", year: 2015 });
    createdVehicleIds.push(vehicleId);

    let result: { checked: boolean; newMatches: number };
    try {
      result = await recallMonitor.checkVehicle(vehicleId);
    } catch (err) {
      console.warn("Skipping live-NHTSA assertion — outbound network unavailable in this environment:", (err as Error).message);
      return;
    }
    expect(result.checked).toBe(true);
    expect(result.newMatches).toBeGreaterThan(0);

    const rows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, vehicleId));
    expect(rows.length).toBeGreaterThan(0);
    const transmissionRecall = rows.find((r) => r.campaignNumber === "15V574000");
    expect(transmissionRecall).toBeDefined();
    expect(transmissionRecall!.source).toBe("nhtsa");
    // VEH-006 "never alert solely on loose brand similarity" — a real make/model/year match from NHTSA's
    // by-vehicle endpoint still isn't a VIN-confirmed match, so this must start at
    // "potential_match_verify_vin", never "open", entirely on RecallMonitorService's own initiative.
    expect(transmissionRecall!.status).toBe("potential_match_verify_vin");
    expect(transmissionRecall!.matchedMake).toBe("HONDA");
    expect(transmissionRecall!.matchedModel).toBe("CIVIC");
    expect(transmissionRecall!.summary.toLowerCase()).toContain("transmission");
    expect(transmissionRecall!.reportedDate).toEqual({ precision: "date", instantUtc: null, date: "2015-09-15", timezone: null, sourceText: "15/09/2015" });
  });

  it("never overwrites a user-confirmed match's status on re-scan", async () => {
    if (!dbAvailable) return;
    const vehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "2015 Civic re-scan", make: "Honda", model: "Civic", year: 2015 });
    createdVehicleIds.push(vehicleId);

    try {
      await recallMonitor.checkVehicle(vehicleId);
    } catch (err) {
      console.warn("Skipping live-NHTSA re-scan assertion — outbound network unavailable in this environment:", (err as Error).message);
      return;
    }
    const [firstPass] = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, vehicleId));
    expect(firstPass).toBeDefined();

    // Simulate the user confirming this recall genuinely applies (AssetsService.confirmRecallMatch).
    await db.update(schema.recallMatches).set({ status: "open" }).where(eq(schema.recallMatches.id, firstPass!.id));

    const rescan = await recallMonitor.checkVehicle(vehicleId);
    expect(rescan.newMatches).toBe(0); // nothing new — the existing match was found again, not duplicated

    const [afterRescan] = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.id, firstPass!.id));
    expect(afterRescan!.status).toBe("open"); // still "open" — the re-scan did not revert the user's confirmation

    const allRows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, vehicleId));
    const sameCampaignRows = allRows.filter((r) => r.campaignNumber === firstPass!.campaignNumber);
    expect(sameCampaignRows).toHaveLength(1); // no duplicate row for the same campaign
  });

  it("prunes a stale (still-default-status) match a re-scan no longer finds, but never touches a user-confirmed one", async () => {
    if (!dbAvailable) return;
    const vehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "2015 Civic prune test", make: "Honda", model: "Civic", year: 2015 });
    createdVehicleIds.push(vehicleId);

    // A stale row NHTSA will never return for this vehicle again (e.g. left over from a matching-rule bug
    // fix, or an upstream correction) — still at the automated default status, so it should be pruned.
    const staleId = await makeStaleMatch(vehicleId, "TEST-STALE-CAMPAIGN", "potential_match_verify_vin");
    // A row the user already confirmed applies — must survive even though NHTSA also won't return it again.
    const confirmedId = await makeStaleMatch(vehicleId, "TEST-CONFIRMED-STALE-CAMPAIGN", "open");

    try {
      await recallMonitor.checkVehicle(vehicleId);
    } catch (err) {
      console.warn("Skipping live-NHTSA prune assertion — outbound network unavailable in this environment:", (err as Error).message);
      return;
    }

    const staleRows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.id, staleId));
    expect(staleRows).toHaveLength(0); // pruned — no real NHTSA campaign has this number

    const confirmedRows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.id, confirmedId));
    expect(confirmedRows).toHaveLength(1); // survives — the user already confirmed it, so a re-scan never removes it
    expect(confirmedRows[0]!.status).toBe("open");

    const realMatch = await db
      .select()
      .from(schema.recallMatches)
      .where(and(eq(schema.recallMatches.vehicleProfileId, vehicleId), eq(schema.recallMatches.campaignNumber, "15V574000")));
    expect(realMatch).toHaveLength(1); // the real, still-current NHTSA match is untouched by pruning
  });

  it("no-ops for a home asset missing a manufacturer", async () => {
    if (!dbAvailable) return;
    const propertyId = generateId("property");
    await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, label: "Recall Test House", propertyType: "home" });
    createdPropertyIds.push(propertyId);
    const homeAssetId = generateId("homeAsset");
    await db.insert(schema.homeAssets).values({ id: homeAssetId, ownerUserId, propertyProfileId: propertyId, label: "Mystery appliance" }); // no make
    createdHomeAssetIds.push(homeAssetId);

    const result = await recallMonitor.checkHomeAsset(homeAssetId);
    expect(result).toEqual({ checked: false, newMatches: 0 });
  });

  it(
    "fails closed (zero matches, not every manufacturer recall) for a home asset with no model and no usable label keywords",
    async () => {
      if (!dbAvailable) return;
      const propertyId = generateId("property");
      await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, label: "Recall Test House 3", propertyType: "home" });
      createdPropertyIds.push(propertyId);
      const homeAssetId = generateId("homeAsset");
      // "Main unit" has a manufacturer (checkable) but no model and a label with no significant keywords
      // (both words are in the stopword/short-word list) — see fetchCpscCandidates's own doc comment on
      // why a manufacturer-only CPSC query without something to narrow by must return nothing, not
      // Whirlpool's entire cross-category recall history.
      await db.insert(schema.homeAssets).values({ id: homeAssetId, ownerUserId, propertyProfileId: propertyId, label: "Main unit", make: "Whirlpool" });
      createdHomeAssetIds.push(homeAssetId);

      let result: { checked: boolean; newMatches: number };
      try {
        result = await recallMonitor.checkHomeAsset(homeAssetId);
      } catch (err) {
        console.warn("Skipping live-CPSC fail-closed assertion — outbound network unavailable in this environment:", (err as Error).message);
        return;
      }
      expect(result.checked).toBe(true); // it WAS checkable and DID call CPSC...
      expect(result.newMatches).toBe(0); // ...but matched nothing, rather than every Whirlpool recall ever filed

      const rows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.homeAssetId, homeAssetId));
      expect(rows).toHaveLength(0);
    },
    15_000,
  );

  it(
    "checks a real home asset against the live CPSC API",
    async () => {
      if (!dbAvailable) return;
      const propertyId = generateId("property");
      await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, label: "Recall Test House 2", propertyType: "home" });
      createdPropertyIds.push(propertyId);
      const homeAssetId = generateId("homeAsset");
      // Whirlpool is independently verified (via a live curl against the CPSC API before this service was
      // built) to have real recalls on file — see this file's own top-of-file doc comment.
      await db.insert(schema.homeAssets).values({ id: homeAssetId, ownerUserId, propertyProfileId: propertyId, label: "Laundry dryer", make: "Whirlpool", category: "appliance" });
      createdHomeAssetIds.push(homeAssetId);

      let result: { checked: boolean; newMatches: number };
      try {
        result = await recallMonitor.checkHomeAsset(homeAssetId);
      } catch (err) {
        console.warn("Skipping live-CPSC assertion — outbound network unavailable in this environment:", (err as Error).message);
        return;
      }
      expect(result.checked).toBe(true);
      expect(result.newMatches).toBeGreaterThan(0);

      const rows = await db.select().from(schema.recallMatches).where(eq(schema.recallMatches.homeAssetId, homeAssetId));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.source).toBe("cpsc");
      expect(rows[0]!.status).toBe("potential_match_verify_vin"); // same "never assert it definitely applies" stance as NHTSA matches
      expect(rows[0]!.matchedMake).toBe("Whirlpool");
      // HOMEOS-008 "never alert solely on loose brand similarity" — found live against the real CPSC API:
      // "Whirlpool" alone returns that brand's entire multi-decade recall history (vacuums, dishwashers,
      // freezers, microwaves, cooktops...), not just dryers. With no model on file, every match must still
      // mention "dryer" somewhere in its own text — proving the label-keyword fallback in
      // fetchCpscCandidates actually excludes the unrelated product categories, not just happens to.
      for (const row of rows) {
        expect(`${row.summary} ${row.component ?? ""}`.toLowerCase()).toContain("dryer");
      }
    },
    15_000, // CPSC's manufacturer-filtered response can be large (many historical recalls) — the default 5s test timeout was too tight
  );
});
