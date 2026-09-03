import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { resolvePriceAdjustmentPolicy, priceAdjustmentDeadline, daysUntil, DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS } from "./price-adjustment-policy";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * RET-004 "Policy engine stores sourced retailer terms with effective dates; deadline calculator" —
 * real-DB proof of the three cases the RET-004 audit named as missing: (1) a merchant-specific policy is
 * actually used, (2) a merchant with no policy falls back to the flat default, (3) a user's own correction
 * outranks a seeded global fact — plus that purchaseDetail's priceAdjustmentPolicy field (deadline,
 * daysLeft, confidence, isDefault) reflects all three correctly. The ingestion-side "does the window check
 * actually change extraction behavior" half of this is covered separately in
 * ingestion.price-adjustment-policy.test.ts; this file is the read/policy-resolution/user-override half.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("RET-004 price-adjustment policy resolution and purchase-detail display", () => {
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
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `padj-policy-${ownerUserId}@example.com`, displayName: "Policy Test Owner" },
        { id: otherUserId, email: `padj-policy-${otherUserId}@example.com`, displayName: "Policy Test Other User" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping RET-004 policy resolution tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  it("a merchant with a specific commonly_known policy resolves to that window, not the flat default", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Policy Resolve Test — Commonly Known" });
    await db.insert(schema.merchantPriceAdjustmentPolicies).values({
      id: generateId("merchantPriceAdjustmentPolicy"),
      merchantId,
      ownerUserId: null,
      windowDays: 14,
      confidence: "commonly_known",
      sourceNote: "Test fixture.",
    });

    const resolved = await resolvePriceAdjustmentPolicy(db, merchantId, ownerUserId);
    expect(resolved.windowDays).toBe(14);
    expect(resolved.confidence).toBe("commonly_known");
    expect(resolved.policyId).not.toBeNull();
  });

  it("a merchant with no policy row at all falls back to the flat 30-day default, confidence assumed", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Policy Resolve Test — No Policy" });

    const resolved = await resolvePriceAdjustmentPolicy(db, merchantId, ownerUserId);
    expect(resolved.windowDays).toBe(DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS);
    expect(resolved.confidence).toBe("assumed");
    expect(resolved.policyId).toBeNull();

    // Also true when no merchant id is known at all (e.g. a purchase with no merchant resolved).
    const resolvedNullMerchant = await resolvePriceAdjustmentPolicy(db, null, ownerUserId);
    expect(resolvedNullMerchant.windowDays).toBe(DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS);
    expect(resolvedNullMerchant.confidence).toBe("assumed");
  });

  it("a user's own user_confirmed correction overrides a seeded global assumed policy, for that user only", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Policy Resolve Test — Assumed Then Corrected" });
    await db.insert(schema.merchantPriceAdjustmentPolicies).values({
      id: generateId("merchantPriceAdjustmentPolicy"),
      merchantId,
      ownerUserId: null,
      windowDays: 30,
      confidence: "assumed",
      sourceNote: "Seeded global guess — not confirmed.",
    });

    // Before any correction, both users see the seeded "assumed" fact.
    const beforeOwner = await resolvePriceAdjustmentPolicy(db, merchantId, ownerUserId);
    expect(beforeOwner.confidence).toBe("assumed");
    expect(beforeOwner.windowDays).toBe(30);

    // The owner corrects it via the same path the purchase-detail policy editor uses.
    await commerce.setMerchantPriceAdjustmentPolicy(merchantId, ownerUserId, { windowDays: 21, sourceNote: "I called support — it's actually 21 days." });

    const afterOwner = await resolvePriceAdjustmentPolicy(db, merchantId, ownerUserId);
    expect(afterOwner.confidence).toBe("user_confirmed");
    expect(afterOwner.windowDays).toBe(21);
    expect(afterOwner.sourceNote).toBe("I called support — it's actually 21 days.");

    // A DIFFERENT user still sees the original seeded "assumed" fact — a personal correction is never a
    // global overwrite (see merchantPriceAdjustmentPolicies' own doc comment).
    const otherUserView = await resolvePriceAdjustmentPolicy(db, merchantId, otherUserId);
    expect(otherUserView.confidence).toBe("assumed");
    expect(otherUserView.windowDays).toBe(30);

    // CommerceService's own read endpoint reflects the same per-caller resolution.
    const viaService = await commerce.merchantPriceAdjustmentPolicy(merchantId, ownerUserId);
    expect(viaService.confidence).toBe("user_confirmed");
    expect(viaService.windowDays).toBe(21);
  });

  it("setMerchantPriceAdjustmentPolicy rejects a merchant id that doesn't exist", async () => {
    if (!dbAvailable) return;
    await expect(commerce.setMerchantPriceAdjustmentPolicy("mer_does_not_exist_xyz", ownerUserId, { windowDays: 10 })).rejects.toThrow();
  });

  it("purchaseDetail's priceAdjustmentPolicy field shows the correct deadline/confidence for a policy-backed merchant, and is null with no adjustment", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Policy Detail Test Merchant" });
    await db.insert(schema.merchantPriceAdjustmentPolicies).values({
      id: generateId("merchantPriceAdjustmentPolicy"),
      merchantId,
      ownerUserId: null,
      windowDays: 20,
      confidence: "commonly_known",
      sourceNote: "Test fixture: a real 20-day policy.",
    });

    const purchaseId = generateId("purchase");
    const purchaseDateSort = new Date("2026-08-01T00:00:00Z");
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId,
      merchantId,
      orderNumber: "POLICY-DETAIL-001",
      purchaseDate: { precision: "date", instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null },
      purchaseDateSort,
      totalMinorUnits: 9_000,
      totalCurrency: "USD",
      state: "candidate",
      confidenceBand: "high",
    });
    const lineId = generateId("purchaseLine");
    await db.insert(schema.purchaseLines).values({
      id: lineId,
      purchaseId,
      productLabel: "Policy Detail Test Widget",
      quantity: 1,
      unitPriceMinorUnits: 9_000,
      lineTotalMinorUnits: 9_000,
      currency: "USD",
    });

    // No price_observations row yet -> nothing to show a deadline/confidence for.
    const beforeAdjustment = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(beforeAdjustment?.priceAdjustments).toHaveLength(0);
    expect(beforeAdjustment?.priceAdjustmentPolicy).toBeNull();

    await db.insert(schema.priceObservations).values({
      id: generateId("priceObservation"),
      subjectEntityId: lineId,
      observedAmountMinorUnits: 6_000,
      observedAmountCurrency: "USD",
      observedAt: new Date("2026-08-10T00:00:00Z"),
      sourceEventId: generateId("sourceEvent"),
    });

    const afterAdjustment = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(afterAdjustment?.priceAdjustments).toHaveLength(1);
    expect(afterAdjustment?.priceAdjustmentPolicy).not.toBeNull();
    expect(afterAdjustment?.priceAdjustmentPolicy?.windowDays).toBe(20);
    expect(afterAdjustment?.priceAdjustmentPolicy?.confidence).toBe("commonly_known");
    expect(afterAdjustment?.priceAdjustmentPolicy?.isDefault).toBe(false);
    const expectedDeadline = priceAdjustmentDeadline(purchaseDateSort, 20);
    expect(afterAdjustment?.priceAdjustmentPolicy?.deadline).toBe(expectedDeadline.toISOString());
    expect(afterAdjustment?.priceAdjustmentPolicy?.daysLeft).toBe(daysUntil(expectedDeadline));

    // Once the owner corrects the policy for this merchant, purchaseDetail picks up the new window/confidence
    // immediately — the deadline calculator is dynamic (resolved at read time), not baked in at ingestion.
    await commerce.setMerchantPriceAdjustmentPolicy(merchantId, ownerUserId, { windowDays: 5 });
    const afterCorrection = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(afterCorrection?.priceAdjustmentPolicy?.windowDays).toBe(5);
    expect(afterCorrection?.priceAdjustmentPolicy?.confidence).toBe("user_confirmed");
    expect(afterCorrection?.priceAdjustmentPolicy?.isDefault).toBe(false);
  });

  it("purchaseDetail falls back to the flat default (isDefault true) for a purchase whose merchant has no policy", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Policy Detail Test — Default Fallback Merchant" });

    const purchaseId = generateId("purchase");
    const purchaseDateSort = new Date("2026-08-01T00:00:00Z");
    await db.insert(schema.purchases).values({
      id: purchaseId,
      ownerUserId,
      merchantId,
      orderNumber: "POLICY-DETAIL-DEFAULT-001",
      purchaseDate: { precision: "date", instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null },
      purchaseDateSort,
      totalMinorUnits: 5_000,
      totalCurrency: "USD",
      state: "candidate",
      confidenceBand: "high",
    });
    const lineId = generateId("purchaseLine");
    await db.insert(schema.purchaseLines).values({
      id: lineId,
      purchaseId,
      productLabel: "Policy Detail Default Widget",
      quantity: 1,
      unitPriceMinorUnits: 5_000,
      lineTotalMinorUnits: 5_000,
      currency: "USD",
    });
    await db.insert(schema.priceObservations).values({
      id: generateId("priceObservation"),
      subjectEntityId: lineId,
      observedAmountMinorUnits: 4_000,
      observedAmountCurrency: "USD",
      observedAt: new Date("2026-08-10T00:00:00Z"),
      sourceEventId: generateId("sourceEvent"),
    });

    const detail = await commerce.purchaseDetail(purchaseId, ownerUserId);
    expect(detail?.priceAdjustmentPolicy?.windowDays).toBe(DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS);
    expect(detail?.priceAdjustmentPolicy?.confidence).toBe("assumed");
    expect(detail?.priceAdjustmentPolicy?.isDefault).toBe(true);
  });
});
