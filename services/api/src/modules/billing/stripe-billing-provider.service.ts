import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common";
import Stripe from "stripe";
import type { PlanKey } from "@veynlo/core";
import { loadEnv } from "../../config/env";
import type { BillingProvider, BillingWebhookEvent } from "./billing-provider.interface";

@Injectable()
export class StripeBillingProvider implements BillingProvider {
  private readonly logger = new Logger(StripeBillingProvider.name);

  isConfigured(): boolean {
    return Boolean(loadEnv().STRIPE_SECRET_KEY);
  }

  private client(): Stripe {
    const key = loadEnv().STRIPE_SECRET_KEY;
    if (!key) {
      throw new ServiceUnavailableException({
        code: "BILLING_NOT_CONFIGURED",
        message: "Billing isn't configured on this deployment yet.",
      });
    }
    return new Stripe(key);
  }

  async createCheckoutSession(params: {
    userId: string;
    planKey: PlanKey;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string | null }> {
    const session = await this.client().checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: params.priceId, quantity: 1 }],
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      client_reference_id: params.userId,
      metadata: { veynloUserId: params.userId, planKey: params.planKey },
      // Without this, only the CheckoutSession object carries this metadata — the Subscription object
      // Stripe creates alongside it does not inherit it automatically. Every later
      // customer.subscription.updated/.deleted webhook event reads userId off the *subscription*, so
      // without this, those events could never resolve which user they were for.
      subscription_data: { metadata: { veynloUserId: params.userId, planKey: params.planKey } },
    });
    return { url: session.url };
  }

  async createPortalSession(params: { customerId: string; returnUrl: string }): Promise<{ url: string | null }> {
    const session = await this.client().billingPortal.sessions.create({
      customer: params.customerId,
      return_url: params.returnUrl,
    });
    return { url: session.url };
  }

  parseWebhookEvent(rawBody: Buffer, signature: string): BillingWebhookEvent {
    const env = loadEnv();
    if (!env.STRIPE_WEBHOOK_SECRET) {
      throw new ServiceUnavailableException({ code: "BILLING_NOT_CONFIGURED", message: "Webhook secret not configured." });
    }
    let event: Stripe.Event;
    try {
      event = this.client().webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${String(err)}`);
      throw err;
    }

    const object = event.data.object as { metadata?: Record<string, string>; client_reference_id?: string };
    const userId = object.metadata?.veynloUserId ?? object.client_reference_id ?? null;
    const planKey = (object.metadata?.planKey as PlanKey | undefined) ?? null;

    let customerId: string | null = null;
    let subscriptionCanceledOrUnpaid = false;
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      customerId = typeof session.customer === "string" ? session.customer : (session.customer?.id ?? null);
    }
    if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
      const subscription = event.data.object as Stripe.Subscription;
      subscriptionCanceledOrUnpaid = subscription.status === "canceled" || subscription.status === "unpaid";
    }

    return { id: event.id, type: event.type, userId, planKey, customerId, subscriptionCanceledOrUnpaid, raw: event.data.object };
  }
}
