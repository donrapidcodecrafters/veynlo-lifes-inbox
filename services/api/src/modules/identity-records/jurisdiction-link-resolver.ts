import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { generateId } from "@veynlo/core";

/**
 * ID-001/002/003 "verifies official external links from curated registry" — resolves the RET-004-shaped
 * `jurisdiction_renewal_links` reference table (see packages/db/src/seed/identity-jurisdiction-links.ts for
 * the seeded rows and its own sourcing discipline). Deliberately NOT a live scrape/fetch of any government
 * site — a small, sourced/seeded table plus a per-user correction path
 * (`setUserJurisdictionLink` below), same non-integration posture `resolvePriceAdjustmentPolicy`
 * (commerce/price-adjustment-policy.ts) already established for RET-004.
 */

export interface ResolvedJurisdictionLink {
  url: string;
  label: string;
  sourceNote: string | null;
  /** "user" — this caller's own correction always wins; "seeded" — the curated global reference row. */
  source: "user" | "seeded";
  linkId: string;
}

/**
 * Precedence: a caller's own `ownerUserId`-scoped row for this exact (recordType, jurisdiction) always
 * outranks the global seeded row, never the reverse — identical precedence rule to
 * `resolvePriceAdjustmentPolicy`'s "a correction one person enters is never overridden by a global seeded
 * fact." Returns null when `jurisdiction` is unset or nothing (seeded or user-corrected) exists for it yet —
 * callers treat that as "no curated link available," never as an error.
 */
export async function resolveJurisdictionLink(
  db: Database,
  recordType: string,
  jurisdiction: string | null,
  ownerUserId: string,
): Promise<ResolvedJurisdictionLink | null> {
  if (!jurisdiction) return null;
  const rows = await db
    .select()
    .from(schema.jurisdictionRenewalLinks)
    .where(
      and(
        eq(schema.jurisdictionRenewalLinks.recordType, recordType),
        eq(schema.jurisdictionRenewalLinks.jurisdiction, jurisdiction),
        or(isNull(schema.jurisdictionRenewalLinks.ownerUserId), eq(schema.jurisdictionRenewalLinks.ownerUserId, ownerUserId)),
      ),
    );
  if (rows.length === 0) return null;

  const userRow = rows.find((r) => r.ownerUserId === ownerUserId);
  const globalRow = rows.find((r) => r.ownerUserId === null);
  const best = userRow ?? globalRow ?? rows[0]!;
  return { url: best.url, label: best.label, sourceNote: best.sourceNote, source: best.ownerUserId ? "user" : "seeded", linkId: best.id };
}

/**
 * Writes/updates one user's own correction for a (recordType, jurisdiction) pair — upserts in place (unlike
 * `setUserPriceAdjustmentPolicy`'s append-only history) since a jurisdiction link has no "effective date"
 * history to preserve, just a single current URL a user is correcting.
 */
export async function setUserJurisdictionLink(
  db: Database,
  ownerUserId: string,
  recordType: string,
  jurisdiction: string,
  input: { url: string; label: string; sourceNote?: string | null },
): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: schema.jurisdictionRenewalLinks.id })
    .from(schema.jurisdictionRenewalLinks)
    .where(
      and(
        eq(schema.jurisdictionRenewalLinks.recordType, recordType),
        eq(schema.jurisdictionRenewalLinks.jurisdiction, jurisdiction),
        eq(schema.jurisdictionRenewalLinks.ownerUserId, ownerUserId),
      ),
    )
    .limit(1);
  if (existing) {
    await db
      .update(schema.jurisdictionRenewalLinks)
      .set({ url: input.url, label: input.label, sourceNote: input.sourceNote ?? null, updatedAt: new Date() })
      .where(eq(schema.jurisdictionRenewalLinks.id, existing.id));
    return { id: existing.id };
  }
  const id = generateId("jurisdictionRenewalLink");
  await db.insert(schema.jurisdictionRenewalLinks).values({
    id,
    recordType,
    jurisdiction,
    ownerUserId,
    url: input.url,
    label: input.label,
    sourceNote: input.sourceNote ?? null,
  });
  return { id };
}
