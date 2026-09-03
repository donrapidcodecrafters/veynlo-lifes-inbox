import type { PlanKey } from "@veynlo/core";

/**
 * §37 "Create Queue, ObjectStorage, Cache, ModelProvider, NotificationProvider, BillingProvider, and
 * Connector interfaces so local mocks can be replaced by AWS/provider implementations" / §22 "Use
 * RevenueCat as the entitlement/subscription normalization layer and Stripe Billing for web purchases."
 * This interface is specifically the Stripe-facing (web billing) half — `StripeBillingProvider` is the
 * only implementation today. RevenueCat (mobile/cross-platform entitlement normalization) is deliberately
 * NOT part of this interface: `RevenueCatService` only receives and normalizes inbound webhooks, it never
 * makes outbound provider calls the way checkout/portal-session creation does, so there's no "swap the
 * provider" boundary for it to sit behind.
 *
 * `BillingService` keeps the domain/DB logic (entitlement rows, billing-event audit trail, Stripe
 * customer-id persistence) — this interface covers only the parts that actually talk to Stripe, mirroring
 * how ModelProvider/ObjectStorage separate "call the external API" from "what the app does with the result."
 */
export interface BillingProvider {
  isConfigured(): boolean;
  createCheckoutSession(params: {
    userId: string;
    planKey: PlanKey;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ url: string | null }>;
  createPortalSession(params: { customerId: string; returnUrl: string }): Promise<{ url: string | null }>;
  /** Verifies the webhook signature and normalizes the provider-specific payload into a plain shape the
   * domain layer can act on without knowing anything Stripe-specific. Throws on signature failure. */
  parseWebhookEvent(rawBody: Buffer, signature: string): BillingWebhookEvent;
}

export interface BillingWebhookEvent {
  id: string;
  type: string;
  userId: string | null;
  planKey: PlanKey | null;
  customerId: string | null;
  subscriptionCanceledOrUnpaid: boolean;
  raw: unknown;
}

/** See queue-producer.interface.ts's identical doc comment for why an explicit token is needed. */
export const BILLING_PROVIDER = Symbol("BILLING_PROVIDER");
