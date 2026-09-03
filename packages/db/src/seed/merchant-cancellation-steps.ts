import { createDbClient } from "../client";
import * as schema from "../schema";

/**
 * SUB-004 "Cancellation assistant ... shows known steps ... when a direct API/partner flow doesn't exist" —
 * a SMALL, honestly-sourced set of well-known, currently-accurate public subscription-cancellation
 * processes. Exactly the same discipline as RET-004's `reference-data.ts` and the identity-records
 * `identity-jurisdiction-links.ts` seed (see both files' own doc comments): idempotent (fixed ids,
 * onConflictDoNothing), safe to re-run against any environment, and NOT a live-fetched/scraped
 * integration — this app has no infrastructure for that, and a service's own cancellation UI can and does
 * change without notice.
 *
 * Deliberately small — nine widely-used services this pass is genuinely confident about, each described at
 * the level of "which menu to open," not exact button copy/pixel positions, since that's the part most
 * likely to drift. Every `sourceNote` says outright that this is general public knowledge as of this
 * seed's authoring, not a live-verified fetch, and to double-check the merchant's own site before relying
 * on it for a real cancellation — same "well-sourced starting point to verify, not ground truth" framing
 * RET-004 and the jurisdiction-links seed both use. A user's own correction (`ownerUserId` set, via
 * PUT /v1/merchants/:id/cancellation-steps) always outranks these seeded rows for that user (see
 * merchant-cancellation-steps.ts's precedence rule).
 *
 * Reuses the same fixed merchant ids as reference-data.ts (mer_amazon, mer_costco) where the merchant is
 * already seeded there, so the two seeds resolve to one shared row rather than duplicating a merchant.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db = createDbClient(connectionString);

  const merchants = [
    // Reused from reference-data.ts (RET-004) — same fixed ids, onConflictDoNothing means whichever seed
    // runs first wins and the other is a no-op for these two rows.
    { id: "mer_amazon", displayName: "Amazon", domain: "amazon.com" },
    { id: "mer_costco", displayName: "Costco Wholesale", domain: "costco.com" },
    { id: "mer_netflix", displayName: "Netflix", domain: "netflix.com" },
    { id: "mer_spotify", displayName: "Spotify", domain: "spotify.com" },
    { id: "mer_disneyplus", displayName: "Disney+", domain: "disneyplus.com" },
    { id: "mer_hulu", displayName: "Hulu", domain: "hulu.com" },
    { id: "mer_adobe", displayName: "Adobe", domain: "adobe.com" },
    { id: "mer_youtube", displayName: "YouTube", domain: "youtube.com" },
    { id: "mer_planetfitness", displayName: "Planet Fitness", domain: "planetfitness.com" },
  ];
  await db.insert(schema.merchants).values(merchants).onConflictDoNothing();

  const cancellationSteps: Array<{ id: string; merchantId: string; steps: string[]; sourceNote: string }> = [
    {
      id: "mcs_seed_netflix",
      merchantId: "mer_netflix",
      steps: [
        "Go to netflix.com and sign in",
        "Click your profile icon (top right), then select \"Account\"",
        "Under \"Membership & Billing\", click \"Cancel Membership\"",
        "Confirm by clicking \"Finish Cancellation\" — you keep access until the end of your current billing period",
      ],
      sourceNote:
        "Netflix's own account page (netflix.com/account) has used this same self-service \"Cancel Membership\" flow for years, with no partner-required or in-person step. General public knowledge as of this seed's authoring, not a live-verified fetch — verify at netflix.com/account before relying on this, since Netflix can change its UI without notice.",
    },
    {
      id: "mcs_seed_spotify",
      merchantId: "mer_spotify",
      steps: [
        "Go to spotify.com/account and sign in",
        "Click \"Subscription\" (or \"Manage your plan\") in the account menu",
        "Click \"Cancel Premium\"",
        "Follow the confirmation prompts — Premium stays active until the end of the paid period",
      ],
      sourceNote:
        "Spotify's account-management page has offered self-service cancellation for years, though its exact page layout has changed more than once. General public knowledge as of this seed's authoring — verify at spotify.com/account before relying on this.",
    },
    {
      id: "mcs_seed_amazon_prime",
      merchantId: "mer_amazon",
      steps: [
        "Go to amazon.com and sign in",
        "Open \"Account & Lists\", then select \"Prime Membership\"",
        "Click \"Manage Membership\", then \"End Membership\"",
        "Choose to end immediately or at the end of the current billing period, then confirm",
      ],
      sourceNote:
        "Amazon's Prime membership management page (amazon.com/prime, under Account & Lists) has used this \"End Membership\" flow for years. This is specifically about the Prime membership subscription, not general Amazon orders. General public knowledge as of this seed's authoring — verify at amazon.com/prime before relying on this.",
    },
    {
      id: "mcs_seed_disneyplus",
      merchantId: "mer_disneyplus",
      steps: [
        "Go to disneyplus.com and sign in",
        "Select your profile icon, then \"Account\"",
        "Under \"Subscription\", click \"Cancel Subscription\"",
        "Follow the prompts to confirm — access continues until the end of the current billing period",
      ],
      sourceNote:
        "Disney+'s account page has offered this self-service cancellation flow since launch. General public knowledge as of this seed's authoring, not a live-verified fetch — verify at disneyplus.com/account before relying on this.",
    },
    {
      id: "mcs_seed_hulu",
      merchantId: "mer_hulu",
      steps: [
        "Go to hulu.com/account and sign in",
        "Under \"Your Subscription\", click \"Cancel\"",
        "Select a reason if prompted, then confirm cancellation",
      ],
      sourceNote:
        "Hulu's account page has offered self-service cancellation for years. General public knowledge as of this seed's authoring — verify at hulu.com/account before relying on this, and note a bundled Disney+/ESPN+ plan may need to be managed from Disney's own account page instead.",
    },
    {
      id: "mcs_seed_adobe_cc",
      merchantId: "mer_adobe",
      steps: [
        "Go to account.adobe.com and sign in",
        "Click \"Plans\", then find your active Creative Cloud plan",
        "Click \"Manage plan\", then \"Cancel plan\"",
        "Read the cancellation-fee warning carefully before confirming — an annual plan paid monthly typically charges a fee for canceling before the year is up, while a true month-to-month plan does not",
      ],
      sourceNote:
        "Adobe's account page (account.adobe.com) has offered this self-service cancel flow for years, and its early-termination fee for annual-paid-monthly plans is well-documented and a common surprise for users. General public knowledge as of this seed's authoring — verify your specific plan's terms at account.adobe.com before relying on this, since the fee only applies to some plan types.",
    },
    {
      id: "mcs_seed_youtube_premium",
      merchantId: "mer_youtube",
      steps: [
        "Go to youtube.com/paid_memberships while signed in",
        "Find your membership and click \"Manage membership\"",
        "Click \"Deactivate\" (YouTube Premium/Music) or \"Cancel membership\" (YouTube TV)",
        "Confirm cancellation — access continues until the end of the current billing period",
      ],
      sourceNote:
        "YouTube's paid-memberships management page has offered this self-service flow for years, covering both YouTube Premium/Music and the separate YouTube TV subscription. General public knowledge as of this seed's authoring — verify at youtube.com/paid_memberships before relying on this.",
    },
    {
      id: "mcs_seed_planet_fitness",
      merchantId: "mer_planetfitness",
      steps: [
        "Contact your home club directly by phone or in person — most Planet Fitness locations have no self-service online cancellation button",
        "If your membership agreement requires it, send a cancellation letter by certified mail (check your signed agreement for the exact requirement)",
        "Ask for written confirmation of the cancellation and its effective date",
        "Check your agreement for a required notice period — commonly one full billing cycle before the cancellation takes effect",
      ],
      sourceNote:
        "Planet Fitness memberships are widely and consistently reported (by the company's own membership agreements and extensive user reporting) to require in-person, phone, or certified-mail cancellation rather than a self-service online flow. Exact requirements vary by franchise location and membership tier/agreement — this is general public knowledge, not a location-specific verified fact, so confirm your specific club's process and your own signed agreement before relying on this.",
    },
    {
      id: "mcs_seed_costco_membership",
      merchantId: "mer_costco",
      steps: [
        "Visit any Costco warehouse's membership counter and request cancellation, or call Costco Member Services",
        "Costco's standard 100% satisfaction guarantee refunds your current membership fee in full, regardless of how long you've held it",
        "Ask for a receipt or confirmation of the cancellation",
      ],
      sourceNote:
        "Costco's long-standing membership satisfaction guarantee (allowing cancellation at any time for a full fee refund) is well-documented on costco.com and widely reported. General public knowledge as of this seed's authoring — verify current terms at costco.com/membership before relying on this.",
    },
  ];
  await db.insert(schema.merchantCancellationSteps).values(cancellationSteps.map((c) => ({ ...c, ownerUserId: null }))).onConflictDoNothing();

  console.log(`Merchant-cancellation-steps seed complete: ${merchants.length} merchants, ${cancellationSteps.length} curated cancellation-step sets.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Merchant-cancellation-steps seed failed:", err);
  process.exit(1);
});
