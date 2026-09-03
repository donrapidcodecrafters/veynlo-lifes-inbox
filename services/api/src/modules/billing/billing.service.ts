import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, or, gt } from "drizzle-orm";
import { generateId, resolveCapability, PLAN_CATALOG, type CapabilityKey, type PlanKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { BILLING_PROVIDER, type BillingProvider } from "./billing-provider.interface";
import { AnalyticsService } from "../analytics/analytics.service";

@Injectable()
export class BillingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(BILLING_PROVIDER) private readonly billingProvider: BillingProvider,
    // §48 product analytics — optional/trailing so existing positional test construction
    // (billing.service.test.ts) keeps compiling unchanged; `this.analytics?.track(...)` below is a no-op
    // when undefined.
    @Inject(AnalyticsService) private readonly analytics?: AnalyticsService,
  ) {}

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

  /**
   * `planKey`/`priceId` both come from the client (the checkout button on the pricing screen), and
   * they're two independent fields the client is free to mismatch — e.g. pay for Plus but request a
   * "family" or the unreleased "pro_agent" checkout. Nothing about Stripe itself stops that: the price
   * actually charged is whatever `priceId` names, while `planKey` is only ever used, unvalidated, as
   * checkout-session metadata that `handleWebhook`'s `checkout.session.completed` handler later reads
   * straight back out to decide which plan's entitlement to grant. Without this check, a user could
   * self-service-escalate to any plan (including one not for sale) by pairing a cheap real `priceId`
   * with an expensive `planKey`. Re-deriving the plan from `priceId` against this deployment's own
   * Stripe price catalog (the same `plans()` catalog the pricing screen itself renders from) closes
   * that gap — the metadata sent to Stripe, and therefore what the webhook can later grant, is always
   * the plan a configured price actually maps to, never client-asserted.
   */
  async createCheckoutSession(userId: string, planKey: PlanKey, priceId: string) {
    const catalogMatch = this.plans().find((p) => p.priceId === priceId);
    if (!catalogMatch || catalogMatch.planKey !== planKey) {
      throw new BadRequestException({
        code: "INVALID_PRICE",
        message: "That price isn't valid for the selected plan.",
      });
    }
    return this.billingProvider.createCheckoutSession({
      userId,
      planKey: catalogMatch.planKey,
      priceId,
      successUrl: `${loadEnv().WEB_APP_URL}/settings/billing?checkout=success`,
      cancelUrl: `${loadEnv().WEB_APP_URL}/settings/billing?checkout=canceled`,
    });
  }

  /** The provider's own self-service "change plan / update card / cancel" UI — requires a billing
   * customer id, which only exists once this user has completed a checkout at least once (see
   * handleWebhook below). */
  async createPortalSession(userId: string) {
    const [user] = await this.db.select({ stripeCustomerId: schema.users.stripeCustomerId }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user?.stripeCustomerId) {
      // Not a transient failure — a free user has no Stripe customer id until their first checkout, which
      // is an expected, permanent state until they subscribe. Confirmed live: this used to throw a 503
      // ServiceUnavailableException, which the global exception filter marks `retryable: true` (any 5xx) —
      // every free-plan tap of "Manage billing" (an extremely common, not-exceptional action) looked like a
      // service outage to logs/monitoring, and any client retry-on-5xx logic would spin on a request that
      // can never succeed until the user actually subscribes. 404 + non-retryable matches the other
      // deterministic business-rule rejections in this codebase (e.g. PASSWORD_REQUIRED's 401).
      throw new NotFoundException({ code: "NO_BILLING_ACCOUNT", message: "Subscribe to a plan first to manage billing." });
    }
    return this.billingProvider.createPortalSession({
      customerId: user.stripeCustomerId,
      returnUrl: `${loadEnv().WEB_APP_URL}/settings/billing`,
    });
  }

  async handleWebhook(rawBody: Buffer, signature: string): Promise<void> {
    const event = this.billingProvider.parseWebhookEvent(rawBody, signature);

    // Stripe explicitly documents that the same event can be delivered more than once (timeouts,
    // retries on their end) — without this check, a redelivered `checkout.session.completed` would
    // insert a second `entitlements` row for the same subscription every time Stripe retries, corrupting
    // the entitlement history (and making a later single-id `AdminService.revokeEntitlement` miss the
    // duplicate). `externalEventId` is Stripe's own event id, unique per real event.
    const [alreadyProcessed] = await this.db
      .select({ id: schema.billingEvents.id })
      .from(schema.billingEvents)
      .where(and(eq(schema.billingEvents.source, "web_stripe"), eq(schema.billingEvents.externalEventId, event.id)))
      .limit(1);
    if (alreadyProcessed) return;

    await this.db.insert(schema.billingEvents).values({
      id: generateId("billingEvent"),
      userId: event.userId ?? "unknown",
      source: "web_stripe",
      externalEventId: event.id,
      eventType: event.type,
      payloadJson: event.raw as Record<string, unknown>,
      processedAt: new Date(),
    });

    if (event.type === "checkout.session.completed" && event.userId) {
      await this.db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId: event.userId,
        planKey: event.planKey ?? "plus",
        source: "web_stripe",
        effectiveFrom: new Date(),
        effectiveTo: null,
      });
      // Needed for the Customer Portal (createPortalSession above) — nothing else in the app ever
      // persists this today, so a user's first checkout is the only place it can be captured.
      if (event.customerId) {
        await this.db.update(schema.users).set({ stripeCustomerId: event.customerId }).where(eq(schema.users.id, event.userId));
      }
      // §48.1 Revenue "free→trial→paid" / Appendix F `subscription_started` — `planKey` is a short catalog
      // enum (never a Stripe price/customer id), safe structured metadata under §48.2.
      await this.analytics?.track("subscription_started", {
        userId: event.userId,
        platform: "web", // checkout.session.completed only ever fires for the web Stripe Checkout flow
        properties: { plan_key: event.planKey ?? "plus" },
      });
    }

    if ((event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") && event.userId && event.subscriptionCanceledOrUnpaid) {
      // Scoped to `source: "web_stripe"` — without it, this closed EVERY open-ended entitlement for the
      // user regardless of where it came from, including a permanent admin-granted `support_granted`
      // entitlement (AdminService.grantEntitlement) or a `revenuecat`-sourced one. Cancelling an unrelated
      // Stripe subscription would silently revoke a comp/goodwill grant an admin explicitly promised the
      // user, with nothing in the admin console indicating why. Mirrors
      // RevenueCatService.closeActiveRevenueCatEntitlements's own `source`-scoped update.
      await this.db
        .update(schema.entitlements)
        .set({ effectiveTo: new Date() })
        .where(
          and(
            eq(schema.entitlements.userId, event.userId),
            eq(schema.entitlements.source, "web_stripe"),
            isNull(schema.entitlements.effectiveTo),
          ),
        );
    }
  }
}
