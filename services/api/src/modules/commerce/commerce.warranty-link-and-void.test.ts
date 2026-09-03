import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

/**
 * Two related, previously-missing pieces closed together since they share the same warranties fixtures:
 *
 *  1. `warranties.propertyProfileId`/`.vehicleProfileId` had no write path at all — CommerceService.
 *     linkWarrantyToAsset (PATCH-style, PUT .../link-asset) is that path.
 *  2. `warranties.voidedAt` had no code path setting it — CommerceService.resolveReturn now sets it when
 *     the return case being resolved has a deterministic `purchaseLineId` matching a warranty's own
 *     `purchaseLineId` (see that method's own comment for why it's scoped that narrowly).
 */
describe("CommerceService — warranty asset linking and return-voiding", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `warranty-link-test-${ownerUserId}@example.com`, displayName: "Warranty Link Test User" });
      otherUserId = generateId("user");
      await db.insert(schema.users).values({ id: otherUserId, email: `warranty-link-other-${otherUserId}@example.com`, displayName: "Warranty Link Other User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CommerceService warranty-link/void tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  async function makeWarranty(): Promise<string> {
    const warrantyId = generateId("warranty");
    const expirationDate = { precision: "date" as const, instantUtc: null, date: "2027-01-01", timezone: null, sourceText: null };
    await db.insert(schema.warranties).values({ id: warrantyId, ownerUserId, productLabel: "Test Refrigerator", expirationDate });
    return warrantyId;
  }

  it("links a warranty to a property, then rejects linking a vehicle without first clearing the property link", async () => {
    if (!dbAvailable) return;
    const warrantyId = await makeWarranty();
    const propertyId = generateId("property");
    await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, label: "Home" });
    const vehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "Car" });

    await commerce.linkWarrantyToAsset(warrantyId, ownerUserId, { propertyProfileId: propertyId });
    const [afterPropertyLink] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(afterPropertyLink?.propertyProfileId).toBe(propertyId);

    await expect(commerce.linkWarrantyToAsset(warrantyId, ownerUserId, { vehicleProfileId: vehicleId })).rejects.toMatchObject({
      response: { code: "CONFLICTING_ASSET_LINK" },
    });

    // Clearing the property link first, then linking the vehicle, succeeds.
    await commerce.linkWarrantyToAsset(warrantyId, ownerUserId, { propertyProfileId: null });
    await commerce.linkWarrantyToAsset(warrantyId, ownerUserId, { vehicleProfileId: vehicleId });
    const [afterVehicleLink] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(afterVehicleLink?.propertyProfileId).toBeNull();
    expect(afterVehicleLink?.vehicleProfileId).toBe(vehicleId);

    await db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
  });

  it("rejects linking a warranty to another user's property", async () => {
    if (!dbAvailable) return;
    const warrantyId = await makeWarranty();
    const othersPropertyId = generateId("property");
    await db.insert(schema.propertyProfiles).values({ id: othersPropertyId, ownerUserId: otherUserId, label: "Someone Else's Home" });

    await expect(commerce.linkWarrantyToAsset(warrantyId, ownerUserId, { propertyProfileId: othersPropertyId })).rejects.toMatchObject({
      response: { code: "NOT_AUTHORIZED" },
    });

    await db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, othersPropertyId));
  });

  async function makePurchaseWithLineAndWarranty(): Promise<{ purchaseId: string; lineId: string; warrantyId: string }> {
    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-07-01", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({ id: purchaseId, ownerUserId, purchaseDate, state: "candidate", confidenceBand: "high" });
    const lineId = generateId("purchaseLine");
    await db.insert(schema.purchaseLines).values({ id: lineId, purchaseId, productLabel: "Espresso Machine" });
    const warrantyId = generateId("warranty");
    const expirationDate = { precision: "date" as const, instantUtc: null, date: "2027-07-01", timezone: null, sourceText: null };
    await db.insert(schema.warranties).values({ id: warrantyId, ownerUserId, purchaseLineId: lineId, productLabel: "Espresso Machine Warranty", expirationDate });
    return { purchaseId, lineId, warrantyId };
  }

  it("resolveReturn voids the warranty for the exact returned line, and the void is idempotent", async () => {
    if (!dbAvailable) return;
    const { purchaseId, lineId, warrantyId } = await makePurchaseWithLineAndWarranty();
    const returnCaseId = generateId("returnCase");
    const deadline = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    await db.insert(schema.returnCases).values({ id: returnCaseId, purchaseId, purchaseLineId: lineId, deadline });

    await commerce.resolveReturn(returnCaseId, ownerUserId);

    const [returnCaseAfter] = await db.select().from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(returnCaseAfter?.state).toBe("resolved");
    const [warrantyAfter] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warrantyAfter?.voidedAt).not.toBeNull();
    const firstVoidedAt = warrantyAfter!.voidedAt!.getTime();

    // Resolving again must not stomp the original voidedAt timestamp (the `isNull` guard in resolveReturn).
    await new Promise((resolve) => setTimeout(resolve, 5));
    await commerce.resolveReturn(returnCaseId, ownerUserId);
    const [warrantyAfterSecondResolve] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warrantyAfterSecondResolve?.voidedAt?.getTime()).toBe(firstVoidedAt);

    await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    await db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    await db.delete(schema.purchaseLines).where(eq(schema.purchaseLines.id, lineId));
    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  });

  it("does NOT void any warranty when the return case has no specific purchaseLineId (ambiguous which line was returned)", async () => {
    if (!dbAvailable) return;
    const { purchaseId, lineId, warrantyId } = await makePurchaseWithLineAndWarranty();
    const returnCaseId = generateId("returnCase");
    const deadline = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };
    // No purchaseLineId — a whole-order return, or an older row predating that column being populated.
    await db.insert(schema.returnCases).values({ id: returnCaseId, purchaseId, deadline });

    await commerce.resolveReturn(returnCaseId, ownerUserId);

    const [warrantyAfter] = await db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    expect(warrantyAfter?.voidedAt).toBeNull();

    await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    await db.delete(schema.warranties).where(eq(schema.warranties.id, warrantyId));
    await db.delete(schema.purchaseLines).where(eq(schema.purchaseLines.id, lineId));
    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
  });
});
