import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { and, eq, gt, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { generateId, PlanKeySchema, type PlanKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { isRevenueCatConfigured, loadEnv } from "../../config/env";
import { timingSafeEqualString } from "../../common/timing-safe-equal";
import { AnalyticsService, type AnalyticsPlatform } from "../analytics/analytics.service";

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
const ENTITLEMENT_REVOKING_EVENTS = new Set(["EXPIRATION"]);

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
    @Inject(AnalyticsService) private readonly analytics: AnalyticsService,
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
    if (!timingSafeEqualString(authHeader, loadEnv().REVENUECAT_WEBHOOK_AUTH_HEADER)) {
      throw new UnauthorizedException({ code: "INVALID_WEBHOOK_AUTH", message: "Invalid webhook authorization." });
    }

    const parsed = RevenueCatWebhookSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`RevenueCat webhook payload failed schema validation: ${parsed.error.message}`);
      return; // ack anyway — a malformed/unrecognized event isn't worth RevenueCat retrying forever
    }
    const event = parsed.data.event;
    const userId = event.app_user_id;

    await this.db.insert(schema.billingEvents).values({
      id: generateId("billingEvent"),
      userId,
      source: mapStoreToSource(event.store),
      externalEventId: event.id,
      eventType: event.type,
      payloadJson: body as Record<string, unknown>,
    });

    if (ENTITLEMENT_GRANTING_EVENTS.has(event.type)) {
      const planKey = firstValidPlanKey(event.entitlement_ids);
      if (!planKey) {
        this.logger.warn(`RevenueCat event ${event.id} (${event.type}) had no entitlement_ids matching a known PlanKey.`);
        return;
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
      // §48.1 Revenue / Appendix F `subscription_started`/`subscription_upgraded` — PRODUCT_CHANGE is
      // RevenueCat's own name for a plan change on an already-active subscription (an upgrade or
      // downgrade), everything else in ENTITLEMENT_GRANTING_EVENTS is a fresh or continuing grant.
      // `planKey` is a short catalog enum, never a store/customer identifier — safe structured metadata
      // under §48.2.
      await this.analytics.track(event.type === "PRODUCT_CHANGE" ? "subscription_upgraded" : "subscription_started", {
        userId,
        platform: analyticsPlatformForStore(event.store),
        properties: { plan_key: planKey },
      });
    }

    if (ENTITLEMENT_REVOKING_EVENTS.has(event.type)) {
      await this.closeActiveRevenueCatEntitlements(userId);
    }
    // CANCELLATION deliberately does nothing here — RevenueCat sends it when a subscription is set to
    // not renew, but access stays active until the real EXPIRATION event fires at period end.
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

/** Same store distinctions as `mapStoreToSource`, collapsed to `AnalyticsPlatform`'s coarser vocabulary —
 * App/Play Store purchases are mobile IAP; RevenueCat's own Stripe integration is a web checkout; anything
 * else has no real client platform to attribute this webhook-driven event to. */
function analyticsPlatformForStore(store: string | undefined): AnalyticsPlatform {
  switch (store) {
    case "APP_STORE":
    case "MAC_APP_STORE":
    case "PLAY_STORE":
      return "mobile";
    case "STRIPE":
      return "web";
    default:
      return "server";
  }
}
