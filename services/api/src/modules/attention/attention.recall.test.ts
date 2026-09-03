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
 * VEH-006/HOMEOS-008 — an unresolved recall (RecallMonitorService's own automated match, or a user-
 * confirmed one) becomes an attention item. Proves: a fresh "potential_match_verify_vin" vehicle recall
 * files as "important"/"needs_review" with verify-VIN wording; a user-confirmed "open" recall files as
 * "critical"/"verified"; a "closed_or_repaired" recall never files at all; a home-asset recall routes to
 * `view_property` instead of `view_vehicle`; and re-running the scan doesn't file a duplicate for the same
 * match (fileIfNew's existing per-resource dedup, same as every other domain this method scans).
 */
describe("AttentionService.scanAndFileDeadlines — recall matches", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let vehicleId: string;
  let propertyId: string;
  let homeAssetId: string;
  let dbAvailable = true;
  const createdRecallMatchIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `recall-attention-${ownerUserId}@example.com`, displayName: "Recall Attention Test" });
      vehicleId = generateId("vehicle");
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "Attention Test Civic", make: "Honda", model: "Civic", year: 2015 });
      propertyId = generateId("property");
      await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, label: "Attention Test House", propertyType: "home" });
      homeAssetId = generateId("homeAsset");
      await db.insert(schema.homeAssets).values({ id: homeAssetId, ownerUserId, propertyProfileId: propertyId, label: "Attention Test Dryer", make: "Whirlpool" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService recall tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdRecallMatchIds) {
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.linkedResourceId, id));
      await db.delete(schema.recallMatches).where(eq(schema.recallMatches.id, id));
    }
    await db.delete(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId));
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeRecallMatch(params: { vehicleProfileId?: string; homeAssetId?: string; status: string; campaignNumber: string }) {
    const id = generateId("recallMatch");
    await db.insert(schema.recallMatches).values({
      id,
      ownerUserId,
      vehicleProfileId: params.vehicleProfileId ?? null,
      homeAssetId: params.homeAssetId ?? null,
      source: params.vehicleProfileId ? "nhtsa" : "cpsc",
      campaignNumber: params.campaignNumber,
      component: "TEST COMPONENT",
      summary: "Test recall summary describing the hazard.",
      status: params.status,
    });
    createdRecallMatchIds.push(id);
    return id;
  }

  async function attentionItemFor(recallMatchId: string) {
    const [row] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "recall_match"), eq(schema.attentionItems.linkedResourceId, recallMatchId)));
    return row ?? null;
  }

  it("files a fresh potential-match vehicle recall as important/needs_review with verify-VIN wording", async () => {
    if (!dbAvailable) return;
    const recallMatchId = await makeRecallMatch({ vehicleProfileId: vehicleId, status: "potential_match_verify_vin", campaignNumber: "TEST-POTENTIAL-1" });
    await attention.scanAndFileDeadlines();
    const item = await attentionItemFor(recallMatchId);
    expect(item).not.toBeNull();
    expect(item!.reasonCode).toBe("vehicle_recall");
    expect(item!.urgency).toBe("important");
    expect(item!.confidenceBand).toBe("needs_review");
    expect(item!.reasonText).toContain("Potential recall");
    expect(item!.reasonText).toContain("verify this affects your specific VIN");
    expect(item!.primaryActions).toEqual(["view_vehicle"]);
  });

  it("files a user-confirmed 'open' recall as critical/verified, without 'verify VIN' wording", async () => {
    if (!dbAvailable) return;
    const recallMatchId = await makeRecallMatch({ vehicleProfileId: vehicleId, status: "open", campaignNumber: "TEST-OPEN-1" });
    await attention.scanAndFileDeadlines();
    const item = await attentionItemFor(recallMatchId);
    expect(item).not.toBeNull();
    expect(item!.urgency).toBe("critical");
    expect(item!.confidenceBand).toBe("verified");
    expect(item!.reasonText).toContain("Confirmed recall");
    expect(item!.reasonText).not.toContain("verify this affects");
  });

  it("never files a closed_or_repaired recall", async () => {
    if (!dbAvailable) return;
    const recallMatchId = await makeRecallMatch({ vehicleProfileId: vehicleId, status: "closed_or_repaired", campaignNumber: "TEST-CLOSED-1" });
    await attention.scanAndFileDeadlines();
    const item = await attentionItemFor(recallMatchId);
    expect(item).toBeNull();
  });

  it("routes a home-asset recall to view_property, not view_vehicle", async () => {
    if (!dbAvailable) return;
    const recallMatchId = await makeRecallMatch({ homeAssetId, status: "potential_match_verify_vin", campaignNumber: "TEST-HOME-1" });
    await attention.scanAndFileDeadlines();
    const item = await attentionItemFor(recallMatchId);
    expect(item).not.toBeNull();
    expect(item!.reasonCode).toBe("home_asset_recall");
    expect(item!.primaryActions).toEqual(["view_property"]);
    expect(item!.reasonText).toContain("verify this affects your specific unit");
  });

  it("doesn't file a duplicate attention item for the same recall match on a re-scan", async () => {
    if (!dbAvailable) return;
    const recallMatchId = await makeRecallMatch({ vehicleProfileId: vehicleId, status: "potential_match_verify_vin", campaignNumber: "TEST-DEDUP-1" });
    await attention.scanAndFileDeadlines();
    await attention.scanAndFileDeadlines();
    const rows = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "recall_match"), eq(schema.attentionItems.linkedResourceId, recallMatchId)));
    expect(rows).toHaveLength(1);
  });
});
