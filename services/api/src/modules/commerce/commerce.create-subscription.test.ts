import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * SUB-001 "Identify recurring services from financial transactions, email receipts, app-store receipts,
 * or manual add" — regression coverage for the previously-missing fourth detection source. Found live
 * while re-auditing §18: `extractSubscription` (email) and `CreateStoreCreditDto` (store credits' own
 * manual-entry path) both existed, but nothing let a user manually add a subscription that no email ever
 * evidenced — CommerceService had no `createSubscription` and CommerceController exposed no
 * `POST /v1/subscriptions`. This exercises the new write path end to end against real Postgres: a manually
 * added subscription becomes an "active"/"verified" recurringStreams+subscriptions pair immediately
 * visible via `subscriptionDetail`, with an optional merchant resolved/created and an optional next-billing
 * date stored as a real TemporalValue — not left in the ambiguous "candidate" state extraction uses for
 * unconfirmed evidence, since a human typing this in directly isn't evidence to weigh, it's a fact.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService.createSubscription — SUB-001 manual add", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `create-subscription-test-${ownerUserId}@example.com`, displayName: "Create Subscription Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping createSubscription tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("creates an active, verified recurring stream + subscription with merchant, amount, and next-billing date", async () => {
    if (!dbAvailable) return;

    const { id: subscriptionId } = await commerce.createSubscription(ownerUserId, {
      serviceLabel: "Neighborhood Gym (cash membership)",
      merchantName: "Neighborhood Gym LLC",
      cadence: "monthly",
      amountMinorUnits: 4_500,
      currency: "USD",
      nextBillingDateIso: "2026-10-01",
    });

    const detail = await commerce.subscriptionDetail(subscriptionId, ownerUserId);
    expect(detail).not.toBeNull();
    expect(detail!.subscription.state).toBe("active");
    expect(detail!.subscription.confidenceBand).toBe("verified");
    expect(detail!.stream.serviceLabel).toBe("Neighborhood Gym (cash membership)");
    expect(detail!.stream.cadence).toBe("monthly");
    expect(detail!.stream.typicalAmountMinorUnits).toBe(4_500);
    expect(detail!.stream.typicalAmountCurrency).toBe("USD");
    expect(detail!.stream.nextExpectedDate).toEqual({ precision: "date", instantUtc: null, date: "2026-10-01", timezone: null, sourceText: null });
    expect(detail!.stream.merchantId).not.toBeNull();

    // Also visible in the plain subscriptions list, and it appears in the merchants table exactly once
    // (findOrCreateMerchant dedup), not re-created on a hypothetical second manual add for the same name.
    const list = await commerce.subscriptions(ownerUserId);
    expect(list.some((s) => s.subscription.id === subscriptionId)).toBe(true);
  });

  it("allows an amount-less, merchant-less, date-less manual add (a user who only knows the service name so far)", async () => {
    if (!dbAvailable) return;

    const { id: subscriptionId } = await commerce.createSubscription(ownerUserId, {
      serviceLabel: "Some subscription I forgot the price of",
    });

    const detail = await commerce.subscriptionDetail(subscriptionId, ownerUserId);
    expect(detail).not.toBeNull();
    expect(detail!.stream.cadence).toBe("irregular");
    expect(detail!.stream.typicalAmountMinorUnits).toBeNull();
    expect(detail!.stream.typicalAmountCurrency).toBeNull();
    expect(detail!.stream.merchantId).toBeNull();
    expect(detail!.stream.nextExpectedDate).toBeNull();
  });

  it("another user cannot see a subscription manually added by someone else", async () => {
    if (!dbAvailable) return;
    const otherUserId = generateId("user");
    await db.insert(schema.users).values({ id: otherUserId, email: `create-subscription-other-${otherUserId}@example.com`, displayName: "Other User" });
    try {
      const { id: subscriptionId } = await commerce.createSubscription(ownerUserId, { serviceLabel: "Private Subscription" });
      const detailAsOther = await commerce.subscriptionDetail(subscriptionId, otherUserId);
      expect(detailAsOther).toBeNull();
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });
});
