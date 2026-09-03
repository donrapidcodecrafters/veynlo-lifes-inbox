import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * Phase 2 §52.2 "safe-spend awareness" — real DB test for the cadence-normalization math and cap
 * comparison, the two things most likely to be silently wrong (an off-by-a-factor bug in the monthly
 * conversion would be invisible without a test actually summing real rows).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  // CommerceService.ownerOrDelegatedHousehold now also calls this (see its doc comment) alongside
  // delegatedHouseholdIds — this test has no household member scenario, so an empty list matches its
  // real no-membership behavior.
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

async function makeSubscription(db: Database, ownerUserId: string, cadence: string, amountMinorUnits: number, state: string) {
  const streamId = generateId("recurringStream");
  await db.insert(schema.recurringStreams).values({
    id: streamId,
    ownerUserId,
    serviceLabel: `Test ${cadence} ${amountMinorUnits}`,
    cadence,
    typicalAmountMinorUnits: amountMinorUnits,
    typicalAmountCurrency: "USD",
  });
  await db.insert(schema.subscriptions).values({ id: generateId("subscription"), recurringStreamId: streamId, state, confidenceBand: "high" });
  return streamId;
}

describe("CommerceService.monthlySpendSummary", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `spend-test-${ownerUserId}@example.com`, displayName: "Spend Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping monthlySpendSummary tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("normalizes weekly/monthly/annual to a monthly total, excludes canceled and irregular, and flags overCap", async () => {
    if (!dbAvailable) return;
    await makeSubscription(db, ownerUserId, "monthly", 1_000, "active"); // counts: 1000
    await makeSubscription(db, ownerUserId, "annual", 12_000, "active"); // counts: 1000/mo equivalent
    await makeSubscription(db, ownerUserId, "weekly", 100, "trial"); // counts: ~433/mo equivalent
    await makeSubscription(db, ownerUserId, "monthly", 5_000, "canceled"); // excluded
    await makeSubscription(db, ownerUserId, "irregular", 9_999, "active"); // excluded — no reliable monthly equivalent

    const noCap = await commerce.monthlySpendSummary(ownerUserId);
    // 1000 + round(12000/12) + round(100*52/12) = 1000 + 1000 + round(433.33) = 2433
    expect(noCap.totalMinorUnits).toBe(2_433);
    expect(noCap.capMinorUnits).toBeNull();
    expect(noCap.overCap).toBe(false);

    await db.insert(schema.notificationPreferences).values({ userId: ownerUserId, monthlySpendCapMinorUnits: 2_000 });
    const withCap = await commerce.monthlySpendSummary(ownerUserId);
    expect(withCap.capMinorUnits).toBe(2_000);
    expect(withCap.overCap).toBe(true);

    // No manual cleanup needed here — recurring_streams/subscriptions/notification_preferences all
    // cascade from `users`, and afterAll's user delete (with its own zero-residual-rows check) covers it.
  });
});
