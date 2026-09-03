import { z } from "zod";
import { PlanKeySchema } from "@veynlo/core";

/**
 * §46 billing checkout — `planKey` here is only a client-declared *hint* used purely for the
 * request-shape check; BillingService.createCheckoutSession never trusts it to determine what
 * entitlement gets granted. The actual plan is always re-derived server-side from `priceId` against
 * the deployment's own Stripe price catalog (see BillingService.plans()/priceIdToPlanKey()) — without
 * that re-derivation, a client could pair an arbitrary `planKey` with any `priceId` (e.g. pay for
 * Plus but request a "family"/"pro_agent" checkout session) and, since the webhook granted whatever
 * planKey showed up in the session metadata, mint an entitlement unrelated to what was actually paid
 * for. Found live during the backend audit — see billing.service.ts's doc comment on
 * createCheckoutSession for the full trace.
 */
export const CreateCheckoutSessionDtoSchema = z.object({
  planKey: PlanKeySchema,
  priceId: z.string().min(1),
});
export type CreateCheckoutSessionDto = z.infer<typeof CreateCheckoutSessionDtoSchema>;
