import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { FinanceService } from "./finance.service";
import { AttentionService } from "../attention/attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

/**
 * FIN-004 "Surface possible duplicate or unexpectedly different charge assistance" — zero code existed for
 * this before (see FinanceService.detectAnomalousTransactions' own doc comment). Uses a REAL
 * AttentionService (not a stub) so these tests prove an actual `attention_items` row gets filed through
 * the real `fileIfNew` dedup path, the same way every other scan in this codebase is tested — not just
 * that some in-memory computation produced the right shape.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

describe("FinanceService.detectAnomalousTransactions", () => {
  let db: Database;
  let finance: FinanceService;
  let attention: AttentionService;
  let ownerUserId: string;
  let connectionId: string;
  let accountId: string;
  let dbAvailable = true;
  let coffeeDupeTxnId: string;
  let highGroceryTxnId: string;
  const txnIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    finance = new FinanceService(db, attention);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `finance-anomaly-test-${ownerUserId}@example.com`, displayName: "Finance Anomaly Test" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "plaid",
        feasibilityClass: "aggregator",
        scopes: ["transactions"],
        enabledCategories: ["purchases", "bills"],
        health: "healthy",
      });
      accountId = generateId("financialAccount");
      await db.insert(schema.financialAccounts).values({
        id: accountId,
        connectionId,
        ownerUserId,
        plaidAccountId: `plaid-acct-${accountId}`,
        name: "Everyday Checking",
        type: "depository",
        currency: "USD",
      });

      const insertTxn = async (opts: { daysAgoOffset: number; amountMinorUnits: number; name: string; merchantName: string | null; pending?: boolean }) => {
        const id = generateId("financialTransaction");
        txnIds.push(id);
        await db.insert(schema.financialTransactions).values({
          id,
          accountId,
          ownerUserId,
          plaidTransactionId: `plaid-txn-${id}`,
          name: opts.name,
          merchantName: opts.merchantName,
          amountMinorUnits: opts.amountMinorUnits,
          currency: "USD",
          pending: opts.pending ?? false,
          postedDate: daysAgo(opts.daysAgoOffset),
        });
        return id;
      };

      // --- Duplicate-charge scenarios ---------------------------------------------------------------
      // True positive: exact same $89.99 charge to the same merchant/account, 1 day apart.
      await insertTxn({ daysAgoOffset: 2, amountMinorUnits: 8_999, name: "COFFEE SHOP #42", merchantName: "Corner Coffee" });
      coffeeDupeTxnId = await insertTxn({ daysAgoOffset: 1, amountMinorUnits: 8_999, name: "COFFEE SHOP #42", merchantName: "Corner Coffee" });

      // False-positive avoidance: same merchant, DIFFERENT amount (a few cents off) within the window —
      // must never be treated as a duplicate (exact-amount-only, precision-first).
      await insertTxn({ daysAgoOffset: 3, amountMinorUnits: 1_299, name: "SANDWICH SHOP", merchantName: "Sandwich Place" });
      await insertTxn({ daysAgoOffset: 4, amountMinorUnits: 1_349, name: "SANDWICH SHOP", merchantName: "Sandwich Place" });

      // False-positive avoidance: same merchant, same amount, but 6 days apart — outside the duplicate window.
      await insertTxn({ daysAgoOffset: 1, amountMinorUnits: 4_500, name: "GYM MEMBERSHIP", merchantName: "City Gym" });
      await insertTxn({ daysAgoOffset: 7, amountMinorUnits: 4_500, name: "GYM MEMBERSHIP", merchantName: "City Gym" });

      // --- Unusual-charge-vs-baseline scenarios -----------------------------------------------------
      // Establish a clean $50 baseline for "Neighborhood Grocery" with several older, unremarkable charges.
      for (const offset of [60, 45, 30]) {
        await insertTxn({ daysAgoOffset: offset, amountMinorUnits: 5_000, name: "NEIGHBORHOOD GROCERY", merchantName: "Neighborhood Grocery" });
      }
      // True positive: a recent charge far above that baseline (>25%).
      highGroceryTxnId = await insertTxn({ daysAgoOffset: 2, amountMinorUnits: 9_000, name: "NEIGHBORHOOD GROCERY", merchantName: "Neighborhood Grocery" });

      // False-positive avoidance: a modest, within-tolerance increase (20% above a clean baseline) must
      // not be flagged.
      for (const offset of [60, 45, 30]) {
        await insertTxn({ daysAgoOffset: offset, amountMinorUnits: 10_000, name: "HARDWARE STORE", merchantName: "Hardware Store" });
      }
      await insertTxn({ daysAgoOffset: 2, amountMinorUnits: 12_000, name: "HARDWARE STORE", merchantName: "Hardware Store" });

      // False-positive avoidance: only 1 prior charge (below TRANSACTION_BASELINE_MIN_SAMPLE) — even a
      // huge jump must not be flagged without enough history to call it a real baseline.
      await insertTxn({ daysAgoOffset: 45, amountMinorUnits: 3_000, name: "POP-UP MARKET", merchantName: "Pop-Up Market" });
      await insertTxn({ daysAgoOffset: 2, amountMinorUnits: 30_000, name: "POP-UP MARKET", merchantName: "Pop-Up Market" });

    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping FinanceService anomaly-detection tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("flags an exact-amount same-merchant charge repeated within a day as a likely duplicate, but not near-misses or charges outside the window", async () => {
    if (!dbAvailable) return;
    await finance.detectAnomalousTransactions();

    const duplicateItems = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.ownerUserId, ownerUserId), eq(schema.attentionItems.reasonCode, "financial_duplicate_charge")));

    expect(duplicateItems).toHaveLength(1);
    expect(duplicateItems[0]?.reasonText).toContain("Corner Coffee");
    expect(duplicateItems[0]?.reasonText).toContain("$89.99");
    expect(duplicateItems[0]?.linkedResourceId).toBe(coffeeDupeTxnId);
    expect(duplicateItems[0]?.primaryActions).toEqual(["looks_right", "dispute_with_bank"]);
    expect(duplicateItems[0]?.confidenceBand).toBe("needs_review");

    // Neither the different-amount pair nor the >2-day-apart pair produced a duplicate flag.
    expect(duplicateItems[0]?.reasonText).not.toContain("Sandwich");
    expect(duplicateItems[0]?.reasonText).not.toContain("Gym");
  });

  it("flags a charge significantly above a merchant's own baseline, but not a modest increase or a merchant with too little history", async () => {
    if (!dbAvailable) return;
    await finance.detectAnomalousTransactions();

    const unusualItems = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.ownerUserId, ownerUserId), eq(schema.attentionItems.reasonCode, "financial_unusual_charge")));

    expect(unusualItems).toHaveLength(1);
    expect(unusualItems[0]?.reasonText).toContain("Neighborhood Grocery");
    expect(unusualItems[0]?.linkedResourceId).toBe(highGroceryTxnId);
    expect(unusualItems[0]?.primaryActions).toEqual(["looks_right", "dispute_with_bank"]);

    // Hardware Store's 20% bump (below the 25% threshold) and Pop-Up Market's single-prior-charge case
    // must not have produced a flag.
    expect(unusualItems.some((i) => i.reasonText.includes("Hardware Store"))).toBe(false);
    expect(unusualItems.some((i) => i.reasonText.includes("Pop-Up Market"))).toBe(false);
  });

  it("does not re-file a duplicate flag it already filed on a second scan (fileIfNew dedup)", async () => {
    if (!dbAvailable) return;
    await finance.detectAnomalousTransactions();
    const duplicateItems = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.ownerUserId, ownerUserId), eq(schema.attentionItems.reasonCode, "financial_duplicate_charge")));
    expect(duplicateItems).toHaveLength(1);
  });
});
