import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * Regression coverage for a currency-mismatch bug found during a money-math audit: `savingsSummary` and
 * `monthlySpendSummary` each used a plain SQL `sum()`/JS accumulator across every matching row with no
 * currency filter, even though `returnCases.valueAtStakeCurrency` / `storeCredits.currency` /
 * `recurringStreams.typicalAmountCurrency` are real per-row fields that can legitimately differ (AI
 * extraction, or a user manually creating a store credit in another currency via CreateStoreCreditDto).
 * Every caller of these two summaries (web + mobile `life.tsx`/`home.tsx`) renders the resulting total as
 * plain USD with no currency shown, so silently adding e.g. EUR cents into that total produced a
 * confidently-wrong number, not just an incomplete one. Both methods now only sum same-currency ("USD")
 * rows; a non-USD row is (for now) excluded from the total rather than mixed in.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService money math — currency-mismatch guards", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `money-math-test-${ownerUserId}@example.com`, displayName: "Money Math Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping money-math tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("savingsSummary sums resolved returns and redeemed/outstanding store credits only within USD, excluding EUR rows rather than mixing them in", async () => {
    if (!dbAvailable) return;

    const purchaseDate = { precision: "date" as const, instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null };

    // A USD purchase with a resolved return worth $50 (5,000 minor units).
    const usdPurchaseId = generateId("purchase");
    await db.insert(schema.purchases).values({
      id: usdPurchaseId,
      ownerUserId,
      orderNumber: "MONEY-MATH-USD-1",
      purchaseDate,
      purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
      totalMinorUnits: 5_000,
      totalCurrency: "USD",
      state: "confirmed",
      confidenceBand: "high",
    });
    await db.insert(schema.returnCases).values({
      id: generateId("returnCase"),
      purchaseId: usdPurchaseId,
      state: "resolved",
      deadline: purchaseDate,
      deadlineSort: new Date("2026-08-15T00:00:00Z"),
      valueAtStakeMinorUnits: 5_000,
      valueAtStakeCurrency: "USD",
    });

    // A EUR purchase with a resolved return worth €70 (7,000 minor units) — must NOT be added to the
    // USD total above (5,000 + 7,000 = 12,000 would be the bug; 5,000 is correct).
    const eurPurchaseId = generateId("purchase");
    await db.insert(schema.purchases).values({
      id: eurPurchaseId,
      ownerUserId,
      orderNumber: "MONEY-MATH-EUR-1",
      purchaseDate,
      purchaseDateSort: new Date("2026-08-01T00:00:00Z"),
      totalMinorUnits: 7_000,
      totalCurrency: "EUR",
      state: "confirmed",
      confidenceBand: "high",
    });
    await db.insert(schema.returnCases).values({
      id: generateId("returnCase"),
      purchaseId: eurPurchaseId,
      state: "resolved",
      deadline: purchaseDate,
      deadlineSort: new Date("2026-08-15T00:00:00Z"),
      valueAtStakeMinorUnits: 7_000,
      valueAtStakeCurrency: "EUR",
    });

    // Store credits: $30 redeemed (USD), €40 redeemed (EUR, must be excluded), $20 outstanding (USD),
    // £15 outstanding (GBP, must be excluded).
    await db.insert(schema.storeCredits).values({
      id: generateId("storeCredit"),
      ownerUserId,
      amountMinorUnits: 3_000,
      currency: "USD",
      redeemed: true,
      redeemedAt: new Date(),
      confidenceBand: "verified",
    });
    await db.insert(schema.storeCredits).values({
      id: generateId("storeCredit"),
      ownerUserId,
      amountMinorUnits: 4_000,
      currency: "EUR",
      redeemed: true,
      redeemedAt: new Date(),
      confidenceBand: "verified",
    });
    await db.insert(schema.storeCredits).values({
      id: generateId("storeCredit"),
      ownerUserId,
      amountMinorUnits: 2_000,
      currency: "USD",
      redeemed: false,
      confidenceBand: "verified",
    });
    await db.insert(schema.storeCredits).values({
      id: generateId("storeCredit"),
      ownerUserId,
      amountMinorUnits: 1_500,
      currency: "GBP",
      redeemed: false,
      confidenceBand: "verified",
    });

    const summary = await commerce.savingsSummary(ownerUserId);
    expect(summary.resolvedReturnsMinorUnits).toBe(5_000); // not 12,000
    expect(summary.redeemedStoreCreditsMinorUnits).toBe(3_000); // not 7,000
    expect(summary.outstandingStoreCreditsMinorUnits).toBe(2_000); // not 3,500
  });

  it("monthlySpendSummary sums only USD-denominated active subscriptions, excluding a non-USD stream rather than mixing it into the USD-labeled total", async () => {
    if (!dbAvailable) return;

    const usdStreamId = generateId("recurringStream");
    await db.insert(schema.recurringStreams).values({
      id: usdStreamId,
      ownerUserId,
      serviceLabel: "USD Monthly Service",
      cadence: "monthly",
      typicalAmountMinorUnits: 1_000,
      typicalAmountCurrency: "USD",
    });
    await db.insert(schema.subscriptions).values({ id: generateId("subscription"), recurringStreamId: usdStreamId, state: "active", confidenceBand: "high" });

    const eurStreamId = generateId("recurringStream");
    await db.insert(schema.recurringStreams).values({
      id: eurStreamId,
      ownerUserId,
      serviceLabel: "EUR Monthly Service",
      cadence: "monthly",
      typicalAmountMinorUnits: 9_000,
      typicalAmountCurrency: "EUR",
    });
    await db.insert(schema.subscriptions).values({ id: generateId("subscription"), recurringStreamId: eurStreamId, state: "active", confidenceBand: "high" });

    const summary = await commerce.monthlySpendSummary(ownerUserId);
    expect(summary.totalMinorUnits).toBe(1_000); // not 10,000 — the EUR stream must be excluded, not added
  });
});
