import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { generateId, PlanKeySchema, type PlanKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { isRevenueCatConfigured, loadEnv } from "../../config/env";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";

/**
 * Only the fields this handler actually reads — RevenueCat's payload carries more, and `.passthrough()`
 * behavior (unknown keys ignored rather than rejected) means an additive change on their side never
 * breaks this validation.
 */
const RevenueCatWebhookSchema = z.object({
  event: z.object({
    id: z.string(),
    type: z.string(),
    app_user_id: z.string(),
    entitlement_ids: z.array(z.string()).nullable().optional(),
    expiration_at_ms: z.number().nullable().optional(),
    store: z.string().optional(),
    environment: z.enum(["SANDBOX", "PRODUCTION"]).optional(),
  }),
});

const ENTITLEMENT_GRANTING_EVENTS = new Set(["INITIAL_PURCHASE", "RENEWAL", "UNCANCELLATION", "PRODUCT_CHANGE", "TRANSFER"]);
// §54.2 launch criteria — REFUND was previously unhandled (only EXPIRATION revoked), the same
// "got their money back, kept the feature" gap `charge.refunded` closes on the Stripe side.
const ENTITLEMENT_REVOKING_EVENTS = new Set(["EXPIRATION", "REFUND"]);

/**
 * RevenueCat (App Store §5.1.1 subscription entitlement normalization) — mirrors the Google/Microsoft
 * connector pattern: entirely optional in dev, returns a clear "not configured" state rather than
 * pretending to work. See docs/BLUEPRINT review — mobile IAP purchase flows themselves can't be tested
 * without a paid Apple/Google developer account regardless of whether this handler exists, so this ships
 * the testable half (webhook-driven entitlement sync, verified below with synthetic payloads matching
 * RevenueCat's documented schema) ahead of the account-gated half (the mobile SDK/paywall UI).
 *
 * Expects one RevenueCat "entitlement" (configured in RevenueCat's own dashboard, not in this code) per
 * Veynlo plan, named to match PlanKeySchema exactly ("plus" | "family" | "pro_agent") — so entitlement_ids
 * maps onto PlanKey with no translation table to keep in sync on both sides.
 */
@Injectable()
export class RevenueCatService {
  private readonly logger = new Logger(RevenueCatService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly notifications: NotificationDeliveryService,
  ) {}

  async handleWebhook(authHeader: string | undefined, body: unknown): Promise<void> {
    if (!isRevenueCatConfigured()) {
      throw new ServiceUnavailableException({
        code: "BILLING_NOT_CONFIGURED",
        message: "RevenueCat isn't configured on this deployment yet.",
      });
    }
    // A static shared value RevenueCat echoes back on every call (configured in its dashboard) — not a
    // cryptographic signature, so this is a plain equality check, not an HMAC verification like Stripe's.
    if (authHeader !== loadEnv().REVENUECAT_WEBHOOK_AUTH_HEADER) {
      throw new UnauthorizedException({ code: "INVALID_WEBHOOK_AUTH", message: "Invalid webhook authorization." });
    }

    const parsed = RevenueCatWebhookSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`RevenueCat webhook payload failed schema validation: ${parsed.error.message}`);
      return; // ack anyway — a malformed/unrecognized event isn't worth RevenueCat retrying forever
    }
    const event = parsed.data.event;
    const userId = event.app_user_id;
    const source = mapStoreToSource(event.store);

    // Same idempotency fix as BillingService.handleWebhook — RevenueCat retries any delivery that
    // doesn't get a 2xx, and this had no dedup at all before, so a retried delivery could double-insert
    // an entitlement grant.
    const inserted = await this.db
      .insert(schema.billingEvents)
      .values({
        id: generateId("billingEvent"),
        userId,
        source,
        externalEventId: event.id,
        eventType: event.type,
        payloadJson: body as Record<string, unknown>,
      })
      .onConflictDoNothing({ target: [schema.billingEvents.source, schema.billingEvents.externalEventId] })
      .returning({ id: schema.billingEvents.id });
    if (inserted.length === 0) {
      this.logger.log(`RevenueCat webhook ${event.id} already processed — skipping.`);
      return;
    }

    if (ENTITLEMENT_GRANTING_EVENTS.has(event.type)) {
      const planKey = firstValidPlanKey(event.entitlement_ids);
      if (!planKey) {
        this.logger.warn(`RevenueCat event ${event.id} (${event.type}) had no entitlement_ids matching a known PlanKey.`);
        return;
      }
      // TRANSFER means the underlying store purchase was reassigned to a different app_user_id than
      // whoever originally bought it — legitimately common (a user gets a new device, reinstalls, and
      // Purchases.logIn(realUserId) naturally transfers their subscription to the new install) but also
      // the one event type that could, in principle, move an entitlement onto an unrelated real account if
      // a device were ever coerced into logging in as someone else. `userId` here is always a real,
      // already-existing Veynlo account (entitlements.userId has a real FK to users.id, so this can never
      // grant to a fabricated/nonexistent account) — the residual risk is narrower: transfer between two
      // real accounts. Verifying that safely needs a real RevenueCat API call this environment has no live
      // credentials to test against (the same constraint already noted for Stripe/RevenueCat elsewhere) —
      // logged distinctly so it's reviewable rather than silently indistinguishable from an ordinary
      // purchase, without blocking the common legitimate case this environment can't tell apart from it.
      if (event.type === "TRANSFER") {
        this.logger.warn(`RevenueCat TRANSFER event ${event.id} granting plan "${planKey}" to user ${userId} — review if unexpected.`);
      }
      // Close any currently-active entitlement from this source before opening a new one — a RENEWAL/
      // PRODUCT_CHANGE is a state transition, not an additive grant, and leaving the old row open would
      // let currentEntitlements() see two "active" plans from the same source at once.
      await this.closeActiveRevenueCatEntitlements(userId);
      await this.db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId,
        planKey,
        source: "revenuecat",
        effectiveFrom: new Date(),
        effectiveTo: event.expiration_at_ms ? new Date(event.expiration_at_ms) : null,
      });
    }

    if (ENTITLEMENT_REVOKING_EVENTS.has(event.type)) {
      await this.closeActiveRevenueCatEntitlements(userId);
    }
    // CANCELLATION deliberately does nothing here — RevenueCat sends it when a subscription is set to
    // not renew, but access stays active until the real EXPIRATION event fires at period end.

    // §54.2 launch criteria #10 "payment-failure... entitlements reconcile correctly" — the same
    // notify-don't-revoke pattern as Stripe's invoice.payment_failed handling. BILLING_ISSUE is
    // RevenueCat's own signal for "the store had trouble billing this subscriber" (an expired card, a
    // declined charge) — access stays active (RevenueCat/the stores retry on their own schedule; only a
    // real EXPIRATION should revoke, already handled above), but the user should know before it lapses.
    if (event.type === "BILLING_ISSUE") {
      await this.notifications.createAndEnqueue({
        ownerUserId: userId,
        dedupeKey: `revenuecat-billing-issue:${event.id}`,
        priority: "important",
        title: "We couldn't process your payment",
        body: "There was a problem billing your subscription through the App/Play Store. Update your payment method there to keep your plan active.",
        category: "billing",
      });
    }
  }

  /**
   * "Active" here must match currentEntitlements()'s own definition (effectiveTo null OR in the future)
   * — grant events always set a real future effectiveTo from RevenueCat's expiration_at_ms, so a row is
   * essentially never actually null after the first grant. Matching only `isNull` here (an earlier version
   * of this method did) meant this query silently matched nothing for any subscription past its first
   * grant — caught by live end-to-end testing (a real EXPIRATION event that should have revoked access,
   * verified through /v1/billing/entitlements, didn't), not by typecheck or the schema-level SAST/audit
   * passes that were run before this.
   */
  private async closeActiveRevenueCatEntitlements(userId: string): Promise<void> {
    const now = new Date();
    await this.db
      .update(schema.entitlements)
      .set({ effectiveTo: now })
      .where(
        and(
          eq(schema.entitlements.userId, userId),
          eq(schema.entitlements.source, "revenuecat"),
          or(isNull(schema.entitlements.effectiveTo), gt(schema.entitlements.effectiveTo, now)),
        ),
      );
  }
}

function firstValidPlanKey(entitlementIds: string[] | null | undefined): PlanKey | null {
  for (const id of entitlementIds ?? []) {
    const result = PlanKeySchema.safeParse(id);
    if (result.success) return result.data;
  }
  return null;
}

function mapStoreToSource(store: string | undefined): string {
  switch (store) {
    case "APP_STORE":
    case "MAC_APP_STORE":
      return "app_store";
    case "PLAY_STORE":
      return "play_store";
    case "STRIPE":
      return "web_stripe";
    default:
      return "revenuecat";
  }
}
