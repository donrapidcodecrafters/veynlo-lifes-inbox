import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * Real DB integration test for the two purchase-detail-page-facing pieces of RET-004/RET-006 that
 * IngestionService's own tests (ingestion.dedup.test.ts) don't reach: `purchaseDetail`'s merchantName +
 * priceAdjustments read-back, and `updatePurchaseLine`'s new `resaleStatus` patch. The write path that
 * actually creates a price_observations row for a purchase line (extractReceipt's new-purchase-line check)
 * is covered end-to-end by ingestion.dedup.test.ts; this test seeds that row directly so it can focus on
 * the read/patch side CommerceService itself owns.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService RET-004/RET-006 (price-adjustment read-back, resale status)", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `resale-test-${ownerUserId}@example.com`, displayName: "Resale Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CommerceService RET-004/RET-006 tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("purchaseDetail returns merchantName and the price_observations written for one of its lines, and updatePurchaseLine can move resaleStatus through not_listed -> listed -> sold", async () => {
    if (!dbAvailable) return;

    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Resale Test Merchant" });

    const purchaseId = generateId("purchase");
    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-05", timezone: null, sourceText: null };
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId,
      merchantId,
      orderNumber: "RESALE-TEST-001",
      purchaseDate,
      purchaseDateSort: new Date("2026-08-05T00:00:00Z"),
      totalMinorUnits: 8_000,
      totalCurrency: "USD",
      state: "candidate",
      confidenceBand: "high",
    });

    const lineId = generateId("purchaseLine");
    await db.insert(schema.purchaseLines).values({
      id: lineId,
      purchaseId,
      productLabel: "Resale Test Widget",
      quantity: 1,
      unitPriceMinorUnits: 8_000,
      lineTotalMinorUnits: 8_000,
      currency: "USD",
    });

    // Seeds directly what IngestionService.extractReceipt would have written on detecting a cheaper
    // repeat purchase — see this file's doc comment for why the write path itself isn't re-exercised here.
    await db.insert(schema.priceObservations).values({
      id: generateId("priceObservation"),
      subjectEntityId: lineId,
      observedAmountMinorUnits: 6_000,
      observedAmountCurrency: "USD",
      observedAt: new Date("2026-08-20T00:00:00Z"),
      sourceEventId: generateId("sourceEvent"),
    });

    const detail = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(detail?.merchantName).toBe("Resale Test Merchant");
    expect(detail?.priceAdjustments).toHaveLength(1);
    expect(detail?.priceAdjustments[0]?.purchaseLineId).toBe(lineId);
    expect(detail?.priceAdjustments[0]?.observedAmountMinorUnits).toBe(6_000);
    expect(detail?.lines[0]?.resaleStatus).toBe("not_listed");

    await commerce.updatePurchaseLine(lineId, ownerUserId, { resaleStatus: "listed" });
    const afterListed = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(afterListed?.lines[0]?.resaleStatus).toBe("listed");

    await commerce.updatePurchaseLine(lineId, ownerUserId, { resaleStatus: "sold" });
    const afterSold = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(afterSold?.lines[0]?.resaleStatus).toBe("sold");
  });
});
