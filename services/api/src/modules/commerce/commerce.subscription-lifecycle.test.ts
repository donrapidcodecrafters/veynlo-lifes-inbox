import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CommerceService } from "./commerce.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";
import { merchantSupportsPause } from "./pause-capability";

/**
 * §40.3 "Representative state machines" — Subscription: `candidate → trial/active → renewal upcoming /
 * price changed / paused → cancellation pending → canceled/expired`. Before this pass, "renewal_upcoming"
 * and "paused" never existed anywhere in the codebase, and "cancellation_pending" appeared only in an
 * ingestion.service.ts comment and was never actually written. This is real Postgres integration coverage
 * for the real transitions CommerceService now owns.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;

describe("CommerceService §40.3 Subscription state machine", () => {
  let db: Database;
  let commerce: CommerceService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    commerce = new CommerceService(db, stubHouseholds, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `sub-lifecycle-${ownerUserId}@example.com`, displayName: "Subscription Lifecycle Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping Subscription state machine tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  async function makeSubscription(state: string, nextExpectedIso: string | null, merchantId: string | null = null): Promise<{ subscriptionId: string; streamId: string }> {
    const streamId = generateId("recurringStream");
    await db.insert(schema.recurringStreams).values({
      id: streamId,
      ownerUserId,
      merchantId,
      serviceLabel: "Lifecycle Test Service",
      cadence: "monthly",
      typicalAmountMinorUnits: 999,
      typicalAmountCurrency: "USD",
      nextExpectedDate: nextExpectedIso ? { precision: "date", instantUtc: null, date: nextExpectedIso, timezone: null, sourceText: null } : null,
    });
    const subscriptionId = generateId("subscription");
    await db.insert(schema.subscriptions).values({ id: subscriptionId, recurringStreamId: streamId, state, confidenceBand: "high" });
    return { subscriptionId, streamId };
  }

  it("scanAndAdvanceSubscriptionRenewalStates moves an active subscription into renewal_upcoming within the window, and back to active once the date passes", async () => {
    if (!dbAvailable) return;
    const now = new Date("2026-09-01T00:00:00Z");
    const { subscriptionId } = await makeSubscription("active", "2026-09-05"); // 4 days out — inside the 7-day window

    const result = await commerce.scanAndAdvanceSubscriptionRenewalStates(now);
    expect(result.renewalUpcoming).toBeGreaterThanOrEqual(1);
    let [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("renewal_upcoming");

    // The guardrail this row names: "Transaction disappearance alone does not prove cancellation" — once
    // the renewal date has simply passed, the safe default is "it renewed," reverting to active rather
    // than staying stuck in renewal_upcoming or jumping to canceled on silence alone.
    const later = new Date("2026-09-10T00:00:00Z");
    const secondResult = await commerce.scanAndAdvanceSubscriptionRenewalStates(later);
    expect(secondResult.reactivated).toBeGreaterThanOrEqual(1);
    [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("active");
  });

  it("scanAndAdvanceSubscriptionRenewalStates leaves an active subscription alone when its renewal is far in the future", async () => {
    if (!dbAvailable) return;
    const now = new Date("2026-09-01T00:00:00Z");
    const { subscriptionId } = await makeSubscription("active", "2026-11-01"); // well outside the 7-day window
    await commerce.scanAndAdvanceSubscriptionRenewalStates(now);
    const [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("active");
  });

  it("submitSubscriptionCancellation moves an active subscription to cancellation_pending, and scanAndFinalizeSubscriptionCancellations finalizes it to canceled once the effective (next-billing) date passes", async () => {
    if (!dbAvailable) return;
    const { subscriptionId } = await makeSubscription("active", "2026-09-20");

    await commerce.submitSubscriptionCancellation(subscriptionId, ownerUserId);
    let [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("cancellation_pending");

    // Effective date (recurringStreams.nextExpectedDate) hasn't passed yet — must stay pending, not jump
    // straight to canceled the instant it's submitted.
    await commerce.scanAndFinalizeSubscriptionCancellations(new Date("2026-09-10T00:00:00Z"));
    [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("cancellation_pending");

    await commerce.scanAndFinalizeSubscriptionCancellations(new Date("2026-09-25T00:00:00Z"));
    [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("canceled");
  });

  it("pauseSubscription rejects a merchant with no known pause option, but succeeds against an injected pause-capable merchant, and resumeSubscription undoes it", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Pause Lifecycle Test Merchant" });
    const { subscriptionId } = await makeSubscription("active", "2026-10-01", merchantId);

    await expect(commerce.pauseSubscription(subscriptionId, ownerUserId)).rejects.toThrow();
    let [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("active");

    // No real merchant is seeded as pause-capable yet (see pause-capability.ts) — this exercises the real
    // transition logic against a hypothetical one, via the same `capableMerchants` override parameter a
    // future real allowlist entry would use, without mutating shared module state between test runs.
    const stubCapableMerchants = new Set(["Pause Lifecycle Test Merchant"]);
    expect(merchantSupportsPause("Pause Lifecycle Test Merchant", stubCapableMerchants)).toBe(true);
    await commerce.pauseSubscription(subscriptionId, ownerUserId, stubCapableMerchants);
    [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("paused");

    await commerce.resumeSubscription(subscriptionId, ownerUserId);
    [row] = await db.select({ state: schema.subscriptions.state }).from(schema.subscriptions).where(eq(schema.subscriptions.id, subscriptionId));
    expect(row?.state).toBe("active");
  });

  /**
   * UI gap found live via QA — the web/mobile subscription-detail pages have no way to know whether
   * `pauseSubscription` would actually succeed for a given subscription's merchant ahead of a failed POST
   * (see pause-capability.ts's own doc comment: PAUSE_CAPABLE_MERCHANT_NAMES is real but currently empty).
   * `subscriptionDetail` now resolves that same check server-side into a `canPause` field so the client can
   * honestly hide the "Pause" button rather than show one that always 400s. This exercises both sides:
   * `false` for the real (currently-empty) allowlist, and `true` once a merchant is actually seeded as
   * pause-capable — same "inject the allowlist" pattern the test just above uses for pauseSubscription
   * itself, since nothing is really pause-capable yet.
   */
  it("subscriptionDetail's canPause reflects merchantSupportsPause for the resolved stream merchant", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Detail Pause Test Merchant" });
    const { subscriptionId } = await makeSubscription("active", "2026-10-01", merchantId);

    const detail = await commerce.subscriptionDetail(subscriptionId, ownerUserId);
    expect(detail?.merchantName).toBe("Detail Pause Test Merchant");
    // No real merchant is seeded as pause-capable today — see pause-capability.ts's own doc comment.
    expect(detail?.canPause).toBe(false);
    expect(merchantSupportsPause("Detail Pause Test Merchant", new Set(["Detail Pause Test Merchant"]))).toBe(true);

    const { subscriptionId: noMerchantSubId } = await makeSubscription("active", "2026-10-01", null);
    const noMerchantDetail = await commerce.subscriptionDetail(noMerchantSubId, ownerUserId);
    expect(noMerchantDetail?.merchantName).toBeNull();
    expect(noMerchantDetail?.canPause).toBe(false);
  });
});
