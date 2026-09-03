import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { generateId } from "@veynlo/core";

/**
 * RET-004 "Price-adjustment opportunity" policy engine.
 *
 * Replaces the old identical-for-every-merchant flat 30-day window (see
 * docs/PHASE2_PENDING_CREDENTIALS.md's RET-004 entry) with a real per-retailer lookup against
 * `merchant_price_adjustment_policies`, while keeping that same flat 30-day window as the fallback for
 * the (large) majority of merchants nothing is known about — see DEFAULT_WINDOW_DAYS below.
 *
 * Deliberately NOT a live scrape/fetch of any merchant's actual current policy page — no such
 * infrastructure exists in this app, and doing that reliably needs either a paid data provider or
 * per-merchant scraping maintenance out of scope for this pass. This is a small, sourced/seeded table
 * (packages/db/src/seed/reference-data.ts) plus a per-user correction path
 * (CommerceService.setMerchantPriceAdjustmentPolicy), not a policy oracle.
 */

export const PRICE_ADJUSTMENT_POLICY_CONFIDENCES = ["user_confirmed", "commonly_known", "assumed"] as const;
export type PriceAdjustmentPolicyConfidence = (typeof PRICE_ADJUSTMENT_POLICY_CONFIDENCES)[number];

/** Same number the old flat heuristic used everywhere — now only the fallback for a merchant with no row at all. */
export const DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS = 30;

export interface ResolvedPriceAdjustmentPolicy {
  windowDays: number;
  confidence: PriceAdjustmentPolicyConfidence;
  sourceNote: string | null;
  /** Null when nothing backs this — it's the flat default, not a real policy row for this merchant. */
  policyId: string | null;
}

const CONFIDENCE_PRECEDENCE: Record<PriceAdjustmentPolicyConfidence, number> = {
  user_confirmed: 2,
  commonly_known: 1,
  assumed: 0,
};

/**
 * Resolves the effective price-adjustment policy for one merchant, from this one caller's point of view.
 *
 * Precedence (highest wins, regardless of which has the more recent `effectiveFrom`):
 *   1. `ownerUserId`'s own "user_confirmed" row for this merchant — a correction one person enters is
 *      never overridden by a global seeded fact, even a newer one.
 *   2. A global "commonly_known" row (ownerUserId null) — a sourced, specific published policy.
 *   3. A global "assumed" row (ownerUserId null) — the merchant is tracked but no confident specific
 *      number exists; still an explicit row (see reference-data.ts) rather than silent fallthrough, so it
 *      shows up in the policy editor as "unconfirmed" instead of just not existing.
 *   4. No row at all -> the flat DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS, confidence "assumed", policyId null.
 * Within the same confidence tier, the row with the latest `effectiveFrom` (that has already taken
 * effect, i.e. <= `now`) wins — "stores sourced retailer terms with EFFECTIVE DATES" is a real multi-row
 * history per merchant (see the table's own doc comment), not a single mutable current value.
 */
export async function resolvePriceAdjustmentPolicy(
  db: Database,
  merchantId: string | null,
  ownerUserId: string,
  now: Date = new Date(),
): Promise<ResolvedPriceAdjustmentPolicy> {
  const fallback: ResolvedPriceAdjustmentPolicy = {
    windowDays: DEFAULT_PRICE_ADJUSTMENT_WINDOW_DAYS,
    confidence: "assumed",
    sourceNote: null,
    policyId: null,
  };
  if (!merchantId) return fallback;

  const rows = await db
    .select()
    .from(schema.merchantPriceAdjustmentPolicies)
    .where(
      and(
        eq(schema.merchantPriceAdjustmentPolicies.merchantId, merchantId),
        lte(schema.merchantPriceAdjustmentPolicies.effectiveFrom, now),
        or(isNull(schema.merchantPriceAdjustmentPolicies.ownerUserId), eq(schema.merchantPriceAdjustmentPolicies.ownerUserId, ownerUserId)),
      ),
    );
  if (rows.length === 0) return fallback;

  rows.sort((a, b) => {
    const precedence = CONFIDENCE_PRECEDENCE[b.confidence as PriceAdjustmentPolicyConfidence] - CONFIDENCE_PRECEDENCE[a.confidence as PriceAdjustmentPolicyConfidence];
    if (precedence !== 0) return precedence;
    return b.effectiveFrom.getTime() - a.effectiveFrom.getTime();
  });
  const best = rows[0]!;
  return {
    windowDays: best.windowDays,
    confidence: best.confidence as PriceAdjustmentPolicyConfidence,
    sourceNote: best.sourceNote,
    policyId: best.id,
  };
}

/** Original purchase date + that merchant's window — the deadline calculator RET-004's spec asks for. */
export function priceAdjustmentDeadline(purchaseDateSort: Date, windowDays: number): Date {
  return new Date(purchaseDateSort.getTime() + windowDays * 86_400_000);
}

/** Whole days remaining until `deadline` (negative once it's passed); used for the "X days left" countdown. */
export function daysUntil(deadline: Date, now: Date = new Date()): number {
  return Math.ceil((deadline.getTime() - now.getTime()) / 86_400_000);
}

/**
 * Writes a user's own correction/addition for one merchant. Always confidence "user_confirmed" and
 * scoped to `ownerUserId` (see this module's doc comment on why a personal correction never becomes a
 * global fact for every other user) — inserts a new row with a fresh `effectiveFrom` rather than mutating
 * any existing row, so a user can change their mind later without destroying the prior entry's history.
 */
export async function setUserPriceAdjustmentPolicy(
  db: Database,
  merchantId: string,
  ownerUserId: string,
  input: { windowDays: number; sourceNote?: string | null },
): Promise<void> {
  await db.insert(schema.merchantPriceAdjustmentPolicies).values({
    id: generateId("merchantPriceAdjustmentPolicy"),
    merchantId,
    ownerUserId,
    windowDays: input.windowDays,
    confidence: "user_confirmed",
    sourceNote: input.sourceNote ?? null,
    effectiveFrom: new Date(),
  });
}
