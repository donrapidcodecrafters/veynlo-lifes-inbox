import { Inject, Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import Stripe from "stripe";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { generateId, resolveCapability, PLAN_CATALOG, type CapabilityKey, type PlanKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(@Inject(DATABASE) private readonly db: Database) {}

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

  /** §46 — the plan catalog this deployment can actually sell, i.e. only the (plan, interval) combinations
   * with a real Stripe Price configured. Unconfigured combinations are omitted entirely rather than shown
   * with a broken "Subscribe" button — same "not configured" degradation as every other optional external
   * dependency. A plan can be monthly-only, annual-only, or both; the client groups rows by planKey. */
  plans() {
    const env = loadEnv();
    const rows: Array<{ planKey: PlanKey; interval: "month" | "year"; priceId: string | undefined }> = [
      { planKey: "plus", interval: "month", priceId: env.STRIPE_PRICE_PLUS_MONTHLY },
      { planKey: "plus", interval: "year", priceId: env.STRIPE_PRICE_PLUS_ANNUAL },
      { planKey: "family", interval: "month", priceId: env.STRIPE_PRICE_FAMILY_MONTHLY },
      { planKey: "family", interval: "year", priceId: env.STRIPE_PRICE_FAMILY_ANNUAL },
    ];
    return rows
      .filter((row): row is { planKey: PlanKey; interval: "month" | "year"; priceId: string } => Boolean(row.priceId))
      .map((row) => ({ planKey: row.planKey, interval: row.interval, priceId: row.priceId, capabilities: PLAN_CATALOG[row.planKey] }));
  }

  async createCheckoutSession(userId: string, planKey: PlanKey, priceId: string) {
    const stripe = this.stripe();
    const session = await stripe.checkout.sessions.create({
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
    });
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
