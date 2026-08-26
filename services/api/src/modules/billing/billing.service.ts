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

  async createCheckoutSession(userId: string, planKey: PlanKey, priceId: string) {
    const stripe = this.stripe();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${loadEnv().WEB_APP_URL}/settings/billing?checkout=success`,
      cancel_url: `${loadEnv().WEB_APP_URL}/settings/billing?checkout=canceled`,
      client_reference_id: userId,
      metadata: { veynloUserId: userId, planKey },
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

    await this.db.insert(schema.billingEvents).values({
      id: generateId("billingEvent"),
      userId: userId ?? "unknown",
      source: "web_stripe",
      externalEventId: event.id,
      eventType: event.type,
      payloadJson: event.data.object as unknown as Record<string, unknown>,
    });

    if (event.type === "checkout.session.completed" && userId) {
      const planKey = ((event.data.object as { metadata?: Record<string, string> }).metadata?.planKey as PlanKey) ?? "plus";
      await this.db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId,
        planKey,
        source: "web_stripe",
        effectiveFrom: new Date(),
        effectiveTo: null,
      });
    }

    if ((event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") && userId) {
      const subscription = event.data.object as Stripe.Subscription;
      if (subscription.status === "canceled" || subscription.status === "unpaid") {
        await this.db
          .update(schema.entitlements)
          .set({ effectiveTo: new Date() })
          .where(and(eq(schema.entitlements.userId, userId), isNull(schema.entitlements.effectiveTo)));
      }
    }
  }
}
