import { createDbClient } from "../client";
import * as schema from "../schema";

/**
 * RET-004 "Policy engine stores sourced retailer terms with effective dates" — a SMALL, honestly-sourced
 * set of major-retailer price-adjustment windows. Unlike seed/run.ts (fictional demo-account data for one
 * made-up household), this is real global reference data, safe to run against ANY environment (dev,
 * staging, production) — idempotent (fixed ids, onConflictDoNothing), so it's safe to re-run freely and
 * is not scoped to any one user or household.
 *
 * Deliberately conservative, per this feature's whole design: this app has no live scrape/fetch of any
 * merchant's actual current policy page (no such infrastructure exists, and retailer policies drift), so
 * only a small number of merchants get a specific, currently-and-historically stable, PUBLICLY documented
 * window at confidence "commonly_known". A retailer's own policy can and does change without notice —
 * treat every "commonly_known" row here as a well-sourced starting point to verify, not ground truth, and
 * a user's own correction (confidence "user_confirmed", via PUT /v1/merchants/:id/price-adjustment-policy)
 * always outranks these seeded rows for that user (see resolvePriceAdjustmentPolicy's precedence rule).
 *
 * High-volume merchants with no single stable published post-purchase price-adjustment policy (Amazon,
 * Walmart) deliberately get an explicit "assumed" row using the app's flat 30-day default, rather than
 * either an invented specific number or silent fallthrough to "no policy at all" — this way they still
 * show up in the policy editor as "tracked but unconfirmed," inviting a user who knows better to correct
 * them, instead of just not existing.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db = createDbClient(connectionString);

  const merchants = [
    { id: "mer_amazon", displayName: "Amazon", domain: "amazon.com" },
    { id: "mer_bestbuy", displayName: "Best Buy", domain: "bestbuy.com" },
    { id: "mer_target", displayName: "Target", domain: "target.com" },
    { id: "mer_costco", displayName: "Costco Wholesale", domain: "costco.com" },
    { id: "mer_walmart", displayName: "Walmart", domain: "walmart.com" },
  ];
  // Uses the SAME fixed ids as seed/run.ts's demo merchants (mer_amazon, mer_bestbuy) so the two seeds
  // resolve to one shared row rather than duplicating a merchant, regardless of which runs first.
  await db.insert(schema.merchants).values(merchants).onConflictDoNothing();

  const policies: Array<{
    id: string;
    merchantId: string;
    windowDays: number;
    confidence: "commonly_known" | "assumed";
    sourceNote: string;
  }> = [
    {
      id: "mpap_seed_target",
      merchantId: "mer_target",
      windowDays: 14,
      confidence: "commonly_known",
      sourceNote:
        "Target's long-published Price Match Guarantee allows a price-adjustment request within 14 days of purchase (Target.com and in-store). Retailer policies can change without notice — verify at target.com before relying on this for a real request.",
    },
    {
      id: "mpap_seed_bestbuy",
      merchantId: "mer_bestbuy",
      windowDays: 15,
      confidence: "commonly_known",
      sourceNote:
        "Best Buy's standard Price Match Guarantee window is 15 days after purchase (extended to 30 days for My Best Buy Elite Plus members, which this app has no way to detect). Verify at bestbuy.com before relying on this for a real request.",
    },
    {
      id: "mpap_seed_costco",
      merchantId: "mer_costco",
      windowDays: 30,
      confidence: "commonly_known",
      sourceNote:
        "Costco's published price-adjustment policy allows a request within 30 days of purchase for eligible items (excludes limited-time/clearance items, which this app has no way to detect). Verify at costco.com before relying on this for a real request.",
    },
    {
      id: "mpap_seed_amazon",
      merchantId: "mer_amazon",
      windowDays: 30,
      confidence: "assumed",
      sourceNote:
        "Amazon has no single, broadly-published general price-adjustment guarantee for most retail purchases — this is the app's flat 30-day default, not a sourced Amazon policy. If you know Amazon's actual current terms (or your own experience getting an adjustment), correct this.",
    },
    {
      id: "mpap_seed_walmart",
      merchantId: "mer_walmart",
      windowDays: 30,
      confidence: "assumed",
      sourceNote:
        "Walmart does not currently publish a general post-purchase price-adjustment guarantee (its old Savings Catcher program was discontinued) — this is the app's flat 30-day default, not a sourced Walmart policy. If you know otherwise, correct this.",
    },
  ];
  await db.insert(schema.merchantPriceAdjustmentPolicies).values(policies).onConflictDoNothing();

  console.log(`Reference-data seed complete: ${merchants.length} merchants, ${policies.length} price-adjustment policies.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Reference-data seed failed:", err);
  process.exit(1);
});
