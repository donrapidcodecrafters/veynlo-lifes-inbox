import { createDbClient } from "../client";
import * as schema from "../schema";

/**
 * "Identity & Legal Continuity" (ID-001/ID-002/ID-003) "verifies official external links from curated
 * registry" — a SMALL, honestly-sourced set of real official-government renewal pages, exactly the same
 * discipline as RET-004's `reference-data.ts` seed (see that file's own doc comment): idempotent (fixed
 * ids, onConflictDoNothing), safe to re-run against any environment, and NOT a live-fetched/scraped
 * integration — this app has no infrastructure for that, and government renewal URLs do occasionally move.
 *
 * Every URL below was verified live during this seed's authoring (fetched directly, or corroborated via a
 * live web search indexing the exact URL on the issuing agency's own domain — see the per-row `sourceNote`
 * for which). Treat every row as a well-sourced starting point to verify yourself before relying on it for
 * a real renewal, exactly like RET-004's own "retailer policies can change without notice" framing — a
 * user's own correction (`ownerUserId` set, via PUT /v1/identity-records/jurisdiction-links) always
 * outranks these seeded rows for that user (see jurisdiction-link-resolver.ts's precedence rule).
 *
 * Deliberately small (one federal passport row + two states' driver's-license pages + two states' vehicle-
 * registration pages) rather than attempting all 50 states — the same "small, curated, user-correctable"
 * posture RET-004 took with five retailers instead of guessing at every merchant's policy.
 */
async function main() {
  const connectionString = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db = createDbClient(connectionString);

  const links: Array<{
    id: string;
    recordType: string;
    jurisdiction: string;
    url: string;
    label: string;
    sourceNote: string;
  }> = [
    {
      id: "jrl_seed_passport_us",
      recordType: "passport",
      jurisdiction: "US",
      url: "https://travel.state.gov/en/passports/renew-replace.html",
      label: "U.S. Department of State — Renew or Replace a Passport",
      sourceNote:
        "The U.S. Department of State's own passport renewal/replacement hub (travel.state.gov). This page blocks automated fetches with its own bot protection, but a live web search independently confirmed this exact URL is indexed under the State Department's own domain as of this seed's authoring. Verify at travel.state.gov before relying on this for a real renewal — the only authorized ONLINE renewal path is opr.travel.state.gov, linked from this page.",
    },
    {
      id: "jrl_seed_dl_us_ca",
      recordType: "drivers_license",
      jurisdiction: "US-CA",
      url: "https://www.dmv.ca.gov/portal/driver-licenses-identification-cards/dl-renewal/",
      label: "California DMV — Driver's License & ID Online Renewal",
      sourceNote: "Live-fetched and confirmed during this seed's authoring (page title: \"Driver's License & ID Online Renewal - California DMV\"). Verify at dmv.ca.gov — eligibility windows and required documents can change.",
    },
    {
      id: "jrl_seed_dl_us_ny",
      recordType: "drivers_license",
      jurisdiction: "US-NY",
      url: "https://dmv.ny.gov/driver-license/renew-driver-license",
      label: "New York State DMV — Renew a Driver License",
      sourceNote: "Live-fetched and confirmed during this seed's authoring (page title: \"Renew a Driver License | NY DMV\"). Verify at dmv.ny.gov before relying on this for a real renewal.",
    },
    {
      id: "jrl_seed_dl_us_tx",
      recordType: "drivers_license",
      jurisdiction: "US-TX",
      url: "https://www.dps.texas.gov/section/driver-license/renew-your-texas-dl-cdl-motorcycle-license-or-id",
      label: "Texas DPS — Renew Your Texas DL, CDL, Motorcycle License or ID",
      sourceNote: "Live-fetched and confirmed during this seed's authoring (Texas Department of Public Safety's own domain, dps.texas.gov). Verify before relying on this for a real renewal.",
    },
    {
      id: "jrl_seed_vehreg_us_ca",
      recordType: "vehicle_registration",
      jurisdiction: "US-CA",
      url: "https://www.dmv.ca.gov/portal/vehicle-registration/vehicle-registration-renewal/",
      label: "California DMV — Renew Your Vehicle's Registration",
      sourceNote: "Live-fetched and confirmed during this seed's authoring (page title: \"Renew Your Vehicle's Registration - California DMV\"). Verify at dmv.ca.gov — smog/insurance requirements vary by vehicle.",
    },
    {
      id: "jrl_seed_vehreg_us_ny",
      recordType: "vehicle_registration",
      jurisdiction: "US-NY",
      url: "https://dmv.ny.gov/registration/renew-a-registration",
      label: "New York State DMV — Renew a Registration",
      sourceNote: "Live-fetched and confirmed during this seed's authoring (page title: \"Renew a Registration | NY DMV\"). Verify at dmv.ny.gov — inspection requirements apply before renewal.",
    },
  ];

  await db.insert(schema.jurisdictionRenewalLinks).values(links.map((l) => ({ ...l, ownerUserId: null }))).onConflictDoNothing();

  console.log(`Identity-jurisdiction-links seed complete: ${links.length} curated official renewal links.`);
  process.exit(0);
}

main().catch((err) => {
  console.error("Identity-jurisdiction-links seed failed:", err);
  process.exit(1);
});
