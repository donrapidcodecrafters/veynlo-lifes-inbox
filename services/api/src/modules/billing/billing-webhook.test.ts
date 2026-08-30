import { describe, expect, it, afterAll, vi } from "vitest";
import Stripe from "stripe";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, and, isNull } from "drizzle-orm";
import { BillingService } from "./billing.service";

/**
 * §46.2/§54.2 launch criteria — Stripe webhook reconciliation is the highest-risk untested flow in the
 * app (double-billing, lost access, or a refunded user keeping their plan are all real-money bugs), but
 * had zero coverage. `stripe.webhooks.generateTestHeaderString` is the Stripe SDK's own documented test
 * helper for this: it computes a real HMAC-SHA256 signature offline (no live Stripe account/network call
 * needed), so `handleWebhook` runs through its actual `constructEvent` signature-verification path rather
 * than one that bypasses it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

const STRIPE_SECRET_KEY = "sk_test_fake_for_billing_webhook_test"; // gitleaks:allow — a fake test key, not a real credential
const STRIPE_WEBHOOK_SECRET = "whsec_test_fake_for_billing_webhook_test"; // gitleaks:allow — same
const PRICE_FAMILY_MONTHLY = "price_family_monthly_test";

process.env.STRIPE_SECRET_KEY = STRIPE_SECRET_KEY;
process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
process.env.STRIPE_PRICE_FAMILY_MONTHLY = PRICE_FAMILY_MONTHLY;

const stripeForSigning = new Stripe(STRIPE_SECRET_KEY);

function sign(payload: string): string {
  return stripeForSigning.webhooks.generateTestHeaderString({ payload, secret: STRIPE_WEBHOOK_SECRET });
}

async function send(billing: BillingService, event: Record<string, unknown>): Promise<void> {
  const payload = JSON.stringify(event);
  await billing.handleWebhook(Buffer.from(payload), sign(payload));
}

const notifications = { createAndEnqueue: vi.fn(async (_params: Record<string, unknown>) => undefined) };

function makeService(): BillingService {
  return new BillingService(db, notifications as never);
}

const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
  const id = generateId("user");
  createdUserIds.push(id);
  await db.insert(schema.users).values({ id, displayName: "Webhook Test User" });
  return id;
}

async function activeEntitlement(userId: string) {
  const [row] = await db
    .select()
    .from(schema.entitlements)
    .where(and(eq(schema.entitlements.userId, userId), isNull(schema.entitlements.effectiveTo)));
  return row ?? null;
}

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, userId));
    await db.delete(schema.billingEvents).where(eq(schema.billingEvents.userId, userId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
});

describe("BillingService.handleWebhook — signature verification", () => {
  it("rejects an event with an invalid signature rather than processing it", async () => {
    const billing = makeService();
    const payload = JSON.stringify({ id: "evt_bad_sig", type: "checkout.session.completed", data: { object: {} } });
    await expect(billing.handleWebhook(Buffer.from(payload), "t=1,v1=not_a_real_signature")).rejects.toThrow();
  });
});

describe("BillingService.handleWebhook — checkout.session.completed", () => {
  it("grants a real entitlement and persists the Stripe customer id", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_test_123", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });

    const entitlement = await activeEntitlement(userId);
    expect(entitlement?.planKey).toBe("plus");
    expect(entitlement?.source).toBe("web_stripe");

    const [user] = await db.select({ stripeCustomerId: schema.users.stripeCustomerId }).from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.stripeCustomerId).toBe("cus_test_123");
  });

  it("is idempotent — a replayed event (same event.id) does not grant a second entitlement", async () => {
    const billing = makeService();
    const userId = await makeUser();
    const event = {
      id: `evt_replay_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_test_456", metadata: { veynloUserId: userId, planKey: "plus" } } },
    };

    await send(billing, event);
    await send(billing, event); // Stripe/RevenueCat both retry on anything but a 2xx — must not double-process

    const rows = await db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, userId));
    expect(rows.length).toBe(1);
  });
});

describe("BillingService.handleWebhook — subscription cancellation", () => {
  it("revokes access when a subscription is canceled", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_cancel_test", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });
    expect(await activeEntitlement(userId)).not.toBeNull();

    await send(billing, {
      id: `evt_cancel_${userId}`,
      type: "customer.subscription.deleted",
      data: { object: { status: "canceled", metadata: { veynloUserId: userId }, items: { data: [] } } },
    });
    expect(await activeEntitlement(userId)).toBeNull();
  });
});

describe("BillingService.handleWebhook — plan change via Customer Portal", () => {
  it("closes the old entitlement and opens a new one at the updated plan when the subscription's price changes", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_upgrade_test", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });
    const before = await activeEntitlement(userId);
    expect(before?.planKey).toBe("plus");

    // A portal-initiated plan switch modifies the SAME subscription in place and never carries the new
    // planKey in metadata (that's stale from checkout time) — only the new price on the subscription items.
    await send(billing, {
      id: `evt_upgrade_${userId}`,
      type: "customer.subscription.updated",
      data: {
        object: {
          status: "active",
          metadata: { veynloUserId: userId },
          items: { data: [{ price: { id: PRICE_FAMILY_MONTHLY } }] },
        },
      },
    });

    const after = await activeEntitlement(userId);
    expect(after?.planKey).toBe("family");
    expect(after?.id).not.toBe(before?.id);

    const closedOld = await db.select().from(schema.entitlements).where(eq(schema.entitlements.id, before!.id));
    expect(closedOld[0]?.effectiveTo).not.toBeNull();
  });

  it("two concurrent plan-switch deliveries for the same subscription never leave two active entitlements (row-locked read-modify-write)", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_race_test", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });

    // Stripe doesn't guarantee strict webhook ordering — two distinct events for the same subscription
    // (e.g. a retried delivery racing a fresh one) can genuinely arrive concurrently.
    await Promise.all([
      send(billing, {
        id: `evt_upgrade_a_${userId}`,
        type: "customer.subscription.updated",
        data: { object: { status: "active", metadata: { veynloUserId: userId }, items: { data: [{ price: { id: PRICE_FAMILY_MONTHLY } }] } } },
      }),
      send(billing, {
        id: `evt_upgrade_b_${userId}`,
        type: "customer.subscription.updated",
        data: { object: { status: "active", metadata: { veynloUserId: userId }, items: { data: [{ price: { id: PRICE_FAMILY_MONTHLY } }] } } },
      }),
    ]);

    const activeRows = await db
      .select()
      .from(schema.entitlements)
      .where(and(eq(schema.entitlements.userId, userId), isNull(schema.entitlements.effectiveTo)));
    expect(activeRows.length).toBe(1);
    expect(activeRows[0]?.planKey).toBe("family");
  });
});

describe("BillingService.handleWebhook — refund reconciliation", () => {
  it("revokes access on a fully refunded charge", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_refund_test", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });
    expect(await activeEntitlement(userId)).not.toBeNull();

    await send(billing, {
      id: `evt_refund_${userId}`,
      type: "charge.refunded",
      data: { object: { customer: "cus_refund_test", refunded: true, amount_refunded: 999 } },
    });
    expect(await activeEntitlement(userId)).toBeNull();
  });

  it("does NOT revoke access on a partial refund (refunded still false)", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_partial_refund_test", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });

    await send(billing, {
      id: `evt_partial_refund_${userId}`,
      type: "charge.refunded",
      data: { object: { customer: "cus_partial_refund_test", refunded: false, amount_refunded: 100 } },
    });
    expect(await activeEntitlement(userId)).not.toBeNull();
  });
});

describe("BillingService.handleWebhook — payment failure", () => {
  it("notifies the user without revoking access, deduped per invoice", async () => {
    const billing = makeService();
    const userId = await makeUser();
    await send(billing, {
      id: `evt_checkout_${userId}`,
      type: "checkout.session.completed",
      data: { object: { id: "cs_test", customer: "cus_fail_test", metadata: { veynloUserId: userId, planKey: "plus" } } },
    });
    notifications.createAndEnqueue.mockClear();

    await send(billing, {
      id: `evt_fail_${userId}`,
      type: "invoice.payment_failed",
      data: { object: { id: `in_${userId}`, customer: "cus_fail_test", hosted_invoice_url: null } },
    });

    expect(notifications.createAndEnqueue).toHaveBeenCalledTimes(1);
    expect(notifications.createAndEnqueue.mock.calls[0]![0]).toMatchObject({
      ownerUserId: userId,
      dedupeKey: `stripe-payment-failed:in_${userId}`,
      category: "billing",
    });
    expect(await activeEntitlement(userId)).not.toBeNull(); // grace period — Stripe's own retries get a chance first
  });
});
