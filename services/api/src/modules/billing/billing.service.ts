import { BadRequestException, Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { generateId, resolveCapability, PLAN_CATALOG, type CapabilityKey, type PlanKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly notifications: NotificationDeliveryService,
  ) {}

  private stripe(): Stripe {
    const key = loadEnv().STRIPE_SECRET_KEY;
    if (!key) {
      throw new ServiceUnavailableException({
        code: "BILLING_NOT_CONFIGURED",
        message: "Billing isn't configured on this deployment yet.",
      });
    }
    return new Stripe(key);
  }

  /**
   * §46 "centralized entitlement evaluation" — the one thing every quota/capability gate elsewhere in the
   * app should call instead of hardcoding a `plan === "plus"` check. Was previously only ever computed as
   * part of `currentEntitlements` (the whole-capability-set view `GET /v1/billing/entitlements` returns) —
   * nothing outside this module actually resolved a single capability to gate an action with, which meant
   * real quotas (connector counts, Ask's per-day cap, document storage, household size) existed only as
   * numbers in `PLAN_CATALOG` with nothing anywhere checking them.
   */
  async getCapability(userId: string, key: CapabilityKey): Promise<ReturnType<typeof resolveCapability>> {
    const now = new Date();
    const active = await this.db
      .select({ planKey: schema.entitlements.planKey, effectiveFrom: schema.entitlements.effectiveFrom, effectiveTo: schema.entitlements.effectiveTo })
      .from(schema.entitlements)
      .where(
        and(
          eq(schema.entitlements.userId, userId),
          or(isNull(schema.entitlements.effectiveTo), gt(schema.entitlements.effectiveTo, now)),
        ),
      );
    return resolveCapability(active as { planKey: PlanKey; effectiveFrom: Date; effectiveTo: Date | null }[], key, now);
  }

  async currentEntitlements(userId: string) {
    const now = new Date();
    const active = await this.db
      .select()
      .from(schema.entitlements)
      .where(
        and(
          eq(schema.entitlements.userId, userId),
          or(isNull(schema.entitlements.effectiveTo), gt(schema.entitlements.effectiveTo, now)),
        ),
      );

    const capabilityInput = active.map((e) => ({
      planKey: e.planKey as PlanKey,
      effectiveFrom: e.effectiveFrom,
      effectiveTo: e.effectiveTo,
    }));
    const capabilities = {} as Record<CapabilityKey, ReturnType<typeof resolveCapability>>;
    for (const key of Object.keys(PLAN_CATALOG.free) as CapabilityKey[]) {
      capabilities[key] = resolveCapability(capabilityInput, key, now);
    }
    const planKey: PlanKey = (active[0]?.planKey as PlanKey) ?? "free";
    return { planKey, entitlements: active, capabilities };
  }

  /** §46 — the plan catalog this deployment can actually sell. On web, only (plan, interval) combinations
   * with a real Stripe Price configured — unconfigured combinations are omitted entirely rather than shown
   * with a broken "Subscribe" button, same "not configured" degradation as every other optional external
   * dependency. Native (iOS/Android) purchasability is gated by RevenueCat/store config instead, which this
   * endpoint has no way to verify (no RevenueCat REST integration here) — so native rows are never
   * Stripe-price-gated; `purchasePlan()` client-side is the actual source of truth there, failing
   * gracefully if the store has no matching offering. `priceId` is unused by the client on native (only
   * the web Stripe-checkout path reads it) and is returned empty in that case. A plan can be monthly-only,
   * annual-only, or both; the client groups rows by planKey. */
  plans(isNativePlatform: boolean) {
    const env = loadEnv();
    const rows: Array<{ planKey: PlanKey; interval: "month" | "year"; priceId: string | undefined }> = [
      { planKey: "plus", interval: "month", priceId: env.STRIPE_PRICE_PLUS_MONTHLY },
      { planKey: "plus", interval: "year", priceId: env.STRIPE_PRICE_PLUS_ANNUAL },
      { planKey: "family", interval: "month", priceId: env.STRIPE_PRICE_FAMILY_MONTHLY },
      { planKey: "family", interval: "year", priceId: env.STRIPE_PRICE_FAMILY_ANNUAL },
    ];
    return rows
      .filter((row) => isNativePlatform || Boolean(row.priceId))
      .map((row) => ({
        planKey: row.planKey,
        interval: row.interval,
        priceId: row.priceId ?? "",
        capabilities: PLAN_CATALOG[row.planKey],
      }));
  }

  async createCheckoutSession(userId: string, planKey: PlanKey, priceId: string) {
    // §46.2 "prevent double subscription when user attempts a second channel" — previously unenforced: a
    // user already on a paid plan through ANY source (Stripe, App Store, Play Store) could still start a
    // brand-new Stripe checkout and end up paying for two overlapping subscriptions at once.
    // resolveCapability already takes the higher of multiple simultaneously-active entitlements (so this
    // was never an access-escalation risk), but it's a real, avoidable way for a user to waste their own
    // money — worth refusing before Stripe ever processes a charge, which this call fully controls.
    // Switching plans or updating payment on an EXISTING Stripe subscription goes through
    // createPortalSession instead, which this doesn't affect.
    const { planKey: currentPlanKey } = await this.currentEntitlements(userId);
    if (currentPlanKey !== "free") {
      throw new BadRequestException({
        code: "ALREADY_SUBSCRIBED",
        message: "You already have an active plan. Manage or change it from your existing subscription instead of starting a new one.",
      });
    }

    const stripe = this.stripe();
    // Backend-robustness "idempotency keys on mutations" — a double-tap on the checkout button or a
    // client retry after a dropped response (nothing here previously guarded against either) would
    // otherwise create two separate, real Stripe Checkout Sessions for the same intent. Bucketed to a
    // 10-second window rather than a single fixed key per (user, plan, price) forever — long enough to
    // absorb a double-click/retry, short enough that a genuinely new checkout attempt later still gets a
    // fresh session rather than replaying a stale/expired one. Stripe itself resolves the idempotency
    // (same key within its own ~24h retention returns the original session, never creates a duplicate).
    const idempotencyKey = createHash("sha256")
      .update(`checkout:${userId}:${planKey}:${priceId}:${Math.floor(Date.now() / 10_000)}`)
      .digest("hex");
    const session = await stripe.checkout.sessions.create(
      {
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${loadEnv().WEB_APP_URL}/settings/billing?checkout=success`,
        cancel_url: `${loadEnv().WEB_APP_URL}/settings/billing?checkout=canceled`,
        client_reference_id: userId,
        metadata: { veynloUserId: userId, planKey },
        // Without this, only the CheckoutSession object carries this metadata — the Subscription object
        // Stripe creates alongside it does not inherit it automatically. Every later
        // customer.subscription.updated/.deleted webhook event (the actual downgrade/cancel-detection path
        // in handleWebhook below) reads userId off the *subscription*, so without this, those events could
        // never resolve which user they were for and the downgrade logic silently never fired.
        subscription_data: { metadata: { veynloUserId: userId, planKey } },
      },
      { idempotencyKey },
    );
    return { url: session.url };
  }

  /** Stripe's own self-service "change plan / update card / cancel" UI — requires a Stripe customer id,
   * which only exists once this user has completed a checkout at least once (see handleWebhook below). */
  async createPortalSession(userId: string) {
    const [user] = await this.db.select({ stripeCustomerId: schema.users.stripeCustomerId }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user?.stripeCustomerId) {
      throw new ServiceUnavailableException({ code: "NO_BILLING_ACCOUNT", message: "Subscribe to a plan first to manage billing." });
    }
    const stripe = this.stripe();
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${loadEnv().WEB_APP_URL}/settings/billing`,
    });
    return { url: session.url };
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const env = loadEnv();
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new ServiceUnavailableException({ code: "BILLING_NOT_CONFIGURED", message: "Webhook secret not configured." });
    }
    const stripe = this.stripe();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${String(err)}`);
      throw err;
    }

    const userId =
      (event.data.object as { metadata?: Record<string, string>; client_reference_id?: string }).metadata?.veynloUserId ??
      (event.data.object as { client_reference_id?: string }).client_reference_id;

    // Stripe (and RevenueCat) retry any delivery that doesn't get a 2xx back — a replayed event must not
    // double-process. `onConflictDoNothing` against the (source, externalEventId) unique index means a
    // retried delivery inserts nothing; an empty `inserted` array is the "already handled" signal.
    const inserted = await this.db
      .insert(schema.billingEvents)
      .values({
        id: generateId("billingEvent"),
        userId: userId ?? "unknown",
        source: "web_stripe",
        externalEventId: event.id,
        eventType: event.type,
        payloadJson: event.data.object as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: [schema.billingEvents.source, schema.billingEvents.externalEventId] })
      .returning({ id: schema.billingEvents.id });
    if (inserted.length === 0) {
      this.logger.log(`Stripe webhook ${event.id} already processed — skipping.`);
      return;
    }

    if (event.type === "checkout.session.completed" && userId) {
      const session = event.data.object as Stripe.Checkout.Session;
      const planKey = (session.metadata?.planKey as PlanKey) ?? "plus";
      await this.db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId,
        planKey,
        source: "web_stripe",
        effectiveFrom: new Date(),
        effectiveTo: null,
      });
      // Needed for the Customer Portal (createPortalSession above) — nothing else in the app ever
      // persists this today, so a user's first checkout is the only place it can be captured.
      const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
      if (customerId) {
        await this.db.update(schema.users).set({ stripeCustomerId: customerId }).where(eq(schema.users.id, userId));
      }
    }

    if ((event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") && userId) {
      const subscription = event.data.object as Stripe.Subscription;
      if (subscription.status === "canceled" || subscription.status === "unpaid") {
        await this.db
          .update(schema.entitlements)
          .set({ effectiveTo: new Date() })
          .where(and(eq(schema.entitlements.userId, userId), isNull(schema.entitlements.effectiveTo)));
      } else {
        // A plan change via Stripe's own Customer Portal (createPortalSession above) modifies this SAME
        // subscription in place — it never fires checkout.session.completed again, so without this branch
        // the entitlement row silently kept serving the OLD planKey forever after an upgrade/downgrade,
        // even though Stripe billed the new price correctly. subscription.metadata.planKey is stale here
        // (it's the plan bought at checkout time, not updated on a portal plan-switch), so the new plan is
        // derived from the subscription's current price instead — same mapping `plans()` uses in reverse.
        const priceId = subscription.items.data[0]?.price?.id;
        const newPlanKey = priceId ? planKeyForPriceId(priceId) : null;
        if (newPlanKey) {
          const [current] = await this.db
            .select({ planKey: schema.entitlements.planKey })
            .from(schema.entitlements)
            .where(and(eq(schema.entitlements.userId, userId), isNull(schema.entitlements.effectiveTo)))
            .limit(1);
          if (current && current.planKey !== newPlanKey) {
            await this.db
              .update(schema.entitlements)
              .set({ effectiveTo: new Date() })
              .where(and(eq(schema.entitlements.userId, userId), isNull(schema.entitlements.effectiveTo)));
            await this.db.insert(schema.entitlements).values({
              id: generateId("entitlement"),
              userId,
              planKey: newPlanKey,
              source: "web_stripe",
              effectiveFrom: new Date(),
              effectiveTo: null,
            });
          }
        }
      }
    }

    // §54.2 launch criteria — refund reconciliation was previously entirely unhandled: a refunded charge
    // left the entitlement it paid for active forever, a real "got their money back, kept the feature"
    // billing bug. `charge.refunded` carries no client_reference_id/metadata (only checkout.session does),
    // so the user is resolved via the reverse stripeCustomerId lookup checkout already persists.
    if (event.type === "charge.refunded") {
      const charge = event.data.object as Stripe.Charge;
      const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
      // `refunded` is only true once the FULL charge amount has been refunded — a partial/goodwill refund
      // (amount_refunded < amount, refunded still false) shouldn't cut off an otherwise-paying subscriber.
      if (charge.refunded && customerId) {
        const refundedUserId = await this.resolveUserIdByStripeCustomer(customerId);
        if (refundedUserId) {
          await this.db
            .update(schema.entitlements)
            .set({ effectiveTo: new Date() })
            .where(and(eq(schema.entitlements.userId, refundedUserId), eq(schema.entitlements.source, "web_stripe"), isNull(schema.entitlements.effectiveTo)));
        }
      }
    }

    // §54.2 launch criteria #10 "payment-failure... entitlements reconcile correctly" — previously
    // entirely unhandled: `customer.subscription.updated` only acts on `canceled`/`unpaid` (see above), so
    // the intermediate `past_due` state a single failed charge produces was a silent no-op — the user kept
    // full access with zero signal anything was wrong, and Stripe's own retry schedule (default: several
    // attempts over ~2-3 weeks) got no chance to succeed with the user aware and able to fix their card in
    // the meantime. Deliberately does NOT revoke access here — Smart Retries genuinely often succeed on
    // their own, and immediately cutting off a subscriber for one transient decline (an expired-but-about-
    // to-be-renewed card, a bank's fraud hold) would be a worse outcome than the current silent grace
    // period. A real notification is the fix: warn early, let `canceled`/`unpaid` (already handled) do the
    // actual revocation once Stripe's own retries are truly exhausted.
    if (event.type === "invoice.payment_failed") {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      if (customerId) {
        const failedUserId = await this.resolveUserIdByStripeCustomer(customerId);
        if (failedUserId) {
          await this.notifications.createAndEnqueue({
            ownerUserId: failedUserId,
            // Deduped per invoice, not per attempt — Stripe retries the same invoice several times before
            // giving up, and re-notifying on every retry would be exactly the "notification fatigue" risk
            // §54.1 names, not a second useful signal.
            dedupeKey: `stripe-payment-failed:${invoice.id}`,
            priority: "important",
            title: "We couldn't process your payment",
            body: invoice.hosted_invoice_url
              ? `Your payment for Veynlo didn't go through. Update your payment method to keep your plan active: ${invoice.hosted_invoice_url}`
              : "Your payment for Veynlo didn't go through. Update your payment method in Billing to keep your plan active.",
            // "billing" is intentionally NOT one of the user-mutable categories in NOTIFICATION_CATEGORIES
            // (apps/web/settings, apps/mobile/notification-preferences) — silencing "you're about to lose
            // access" is a real harm a category mute shouldn't be able to cause, unlike muting e.g. bill
            // reminders. Still respects quiet hours (priority "important", not "critical") since this
            // isn't a security emergency, just an account-status heads up.
            category: "billing",
          });
        }
      }
    }
  }

  private async resolveUserIdByStripeCustomer(customerId: string): Promise<string | null> {
    const [row] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.stripeCustomerId, customerId)).limit(1);
    return row?.id ?? null;
  }

  /**
   * §54.2 Operations "billing support" — admin tooling before this could only grant/revoke Veynlo's own
   * internal entitlements, with no way to actually give a customer their money back. Real, live data
   * (not cached/stored anywhere) since a refund decision needs the charge's actual current state, not a
   * snapshot that could already be stale by the time an admin acts on it.
   */
  async listRecentCharges(userId: string): Promise<
    Array<{
      id: string;
      amountMinorUnits: number;
      currency: string;
      createdAt: string;
      description: string | null;
      refunded: boolean;
      amountRefundedMinorUnits: number;
      status: string;
    }>
  > {
    const [user] = await this.db.select({ stripeCustomerId: schema.users.stripeCustomerId }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user?.stripeCustomerId) return []; // never billed through Stripe -- nothing to show, not an error
    const stripe = this.stripe();
    const charges = await stripe.charges.list({ customer: user.stripeCustomerId, limit: 20 });
    return charges.data.map((c) => ({
      id: c.id,
      amountMinorUnits: c.amount,
      currency: c.currency,
      createdAt: new Date(c.created * 1000).toISOString(),
      description: c.description,
      refunded: c.refunded,
      amountRefundedMinorUnits: c.amount_refunded,
      status: c.status,
    }));
  }

  /**
   * Deliberately requires the charge to resolve back to a real Veynlo user via the same reverse
   * stripeCustomerId lookup the charge.refunded webhook reconciliation above uses — an admin can only act
   * on a charge this system can actually attribute to an account, not an arbitrary Stripe charge ID
   * mistyped or copied from the wrong place. Money actually moves here; this is not reversible by Veynlo
   * itself (a refunded refund isn't a thing) — the caller (admin.controller) gates this behind the rarer
   * superadmin role, the same tier as revoking another admin's access.
   */
  async refundCharge(chargeId: string, actorAdminId: string, note?: string): Promise<{ refundId: string; amountMinorUnits: number; userId: string }> {
    const stripe = this.stripe();
    const charge = await stripe.charges.retrieve(chargeId);
    const customerId = typeof charge.customer === "string" ? charge.customer : charge.customer?.id;
    const userId = customerId ? await this.resolveUserIdByStripeCustomer(customerId) : null;
    if (!userId) {
      throw new BadRequestException({
        code: "CHARGE_NOT_LINKED_TO_USER",
        message: "This charge isn't linked to a known Veynlo account. If a refund is really intended, issue it directly in the Stripe dashboard.",
      });
    }
    if (charge.refunded) {
      throw new BadRequestException({ code: "ALREADY_REFUNDED", message: "This charge has already been fully refunded." });
    }
    const refund = await stripe.refunds.create({ charge: chargeId, reason: "requested_by_customer" });
    this.logger.warn(
      `Admin ${actorAdminId} issued a Stripe refund of ${refund.amount} ${charge.currency} for charge ${chargeId} (user ${userId})${note ? ` — ${note}` : ""}`,
    );
    return { refundId: refund.id, amountMinorUnits: refund.amount ?? charge.amount, userId };
  }
}

/** Reverse of `plans()`'s priceId lookup — maps a Stripe Price back onto the Veynlo plan it represents, so
 * a portal-initiated upgrade/downgrade (which only ever changes the subscription's price, not its
 * metadata) can be detected from the webhook payload alone. */
function planKeyForPriceId(priceId: string): PlanKey | null {
  const env = loadEnv();
  const entries: Array<[string | undefined, PlanKey]> = [
    [env.STRIPE_PRICE_PLUS_MONTHLY, "plus"],
    [env.STRIPE_PRICE_PLUS_ANNUAL, "plus"],
    [env.STRIPE_PRICE_FAMILY_MONTHLY, "family"],
    [env.STRIPE_PRICE_FAMILY_ANNUAL, "family"],
  ];
  return entries.find(([id]) => id === priceId)?.[1] ?? null;
}
