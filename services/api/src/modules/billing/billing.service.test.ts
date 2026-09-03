process.env.STRIPE_PRICE_PLUS_MONTHLY = "price_test_plus_monthly";
process.env.STRIPE_PRICE_FAMILY_MONTHLY = "price_test_family_monthly";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type PlanKey } from "@veynlo/core";
import { BillingService } from "./billing.service";
import type { BillingProvider, BillingWebhookEvent } from "./billing-provider.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/** A stub Stripe provider — same shape a real webhook delivery would produce, just skipping the network/signature layer. */
function fakeProvider(nextEvent?: Partial<BillingWebhookEvent>): BillingProvider {
  return {
    isConfigured: () => true,
    createCheckoutSession: async () => ({ url: "https://checkout.stripe.com/test" }),
    createPortalSession: async () => ({ url: "https://billing.stripe.com/test" }),
    parseWebhookEvent: () => ({
      id: "evt_test",
      type: "checkout.session.completed",
      userId: null,
      planKey: null,
      customerId: null,
      subscriptionCanceledOrUnpaid: false,
      raw: {},
      ...nextEvent,
    }),
  };
}

describe("BillingService", () => {
  let db: Database;
  let userId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      userId = generateId("user");
      await db.insert(schema.users).values({ id: userId, email: `billing-test-${userId}@example.com`, displayName: "Billing Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping BillingService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, userId));
      await db.delete(schema.billingEvents).where(eq(schema.billingEvents.userId, userId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId));
      expect(remaining).toHaveLength(0);
    }
  });

  /**
   * Found live during the backend audit: `createCheckoutSession` used to pass the client-supplied
   * `planKey` straight through to Stripe checkout-session metadata with zero correlation check against
   * `priceId` — a user could pair a cheap real `priceId` with an expensive `planKey` ("family"/
   * "pro_agent") and the later `checkout.session.completed` webhook would grant whatever planKey showed
   * up in that metadata. This proves the fix: a mismatched pair is rejected before any Stripe call.
   */
  it("rejects a checkout request whose planKey doesn't match the priceId's real plan", async () => {
    if (!dbAvailable) return;
    const billing = new BillingService(db, fakeProvider());
    await expect(billing.createCheckoutSession(userId, "family" as PlanKey, "price_test_plus_monthly")).rejects.toMatchObject({
      response: { code: "INVALID_PRICE" },
    });
    // The legitimate pairing still works.
    await expect(billing.createCheckoutSession(userId, "plus" as PlanKey, "price_test_plus_monthly")).resolves.toMatchObject({
      url: expect.any(String),
    });
  });

  /**
   * Found live: `customer.subscription.deleted`/`.updated` closed EVERY open-ended entitlement for the
   * user with no `source` filter, wiping out an unrelated permanent admin-granted (`support_granted`)
   * entitlement whenever that same user's Stripe subscription was separately cancelled. This proves the
   * fix: only the `web_stripe`-sourced entitlement is closed; the admin grant survives untouched.
   */
  it("only closes web_stripe entitlements on subscription cancellation, not an unrelated admin grant", async () => {
    if (!dbAvailable) return;
    const stripeEntitlementId = generateId("entitlement");
    const adminEntitlementId = generateId("entitlement");
    await db.insert(schema.entitlements).values([
      { id: stripeEntitlementId, userId, planKey: "plus", source: "web_stripe", effectiveFrom: new Date(), effectiveTo: null },
      { id: adminEntitlementId, userId, planKey: "family", source: "support_granted", effectiveFrom: new Date(), effectiveTo: null },
    ]);

    const billing = new BillingService(
      db,
      fakeProvider({ id: "evt_cancel_1", type: "customer.subscription.deleted", userId, subscriptionCanceledOrUnpaid: true }),
    );
    await billing.handleWebhook(Buffer.from(""), "sig");

    const [stripeRow] = await db.select().from(schema.entitlements).where(eq(schema.entitlements.id, stripeEntitlementId));
    const [adminRow] = await db.select().from(schema.entitlements).where(eq(schema.entitlements.id, adminEntitlementId));
    expect(stripeRow?.effectiveTo).not.toBeNull(); // correctly closed
    expect(adminRow?.effectiveTo).toBeNull(); // must survive — this was the bug

    await db.delete(schema.entitlements).where(inArray(schema.entitlements.id, [stripeEntitlementId, adminEntitlementId]));
  });

  /**
   * Found live: a redelivered Stripe webhook (Stripe explicitly documents at-least-once delivery) had
   * nothing stopping it from re-running `checkout.session.completed`'s side effects, inserting a second
   * `entitlements` row for the same subscription every time. Proves the fix: the same `externalEventId`
   * processed twice only ever grants one entitlement.
   */
  it("is idempotent against a redelivered checkout.session.completed webhook", async () => {
    if (!dbAvailable) return;
    const eventId = `evt_checkout_${generateId("billingEvent")}`;
    const billing = new BillingService(
      db,
      fakeProvider({ id: eventId, type: "checkout.session.completed", userId, planKey: "plus" as PlanKey }),
    );
    await billing.handleWebhook(Buffer.from(""), "sig");
    await billing.handleWebhook(Buffer.from(""), "sig"); // Stripe redelivers the identical event

    const grants = await db
      .select()
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.userId, userId), eq(schema.entitlements.source, "web_stripe")));
    expect(grants).toHaveLength(1);

    const events = await db
      .select()
      .from(schema.billingEvents)
      .where(and(eq(schema.billingEvents.userId, userId), eq(schema.billingEvents.externalEventId, eventId)));
    expect(events).toHaveLength(1);
  });
});
