import { and, eq, isNull, or } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { generateId } from "@veynlo/core";

/**
 * SUB-004 "Help end unwanted subscription ... shows known steps/link/evidence" — resolves the
 * RET-004/jurisdiction_links-shaped `merchant_cancellation_steps` reference table (see
 * packages/db/src/seed/merchant-cancellation-steps.ts for the seeded rows and that file's own sourcing
 * discipline). Deliberately NOT a live scrape/fetch, and deliberately NOT a direct-cancel API/partner
 * integration — this is a small, sourced/seeded table of plain-text STEPS TO FOLLOW plus a per-user
 * correction path (`setUserMerchantCancellationSteps` below), same non-integration posture
 * `resolvePriceAdjustmentPolicy` (price-adjustment-policy.ts) and `resolveJurisdictionLink`
 * (identity-records/jurisdiction-link-resolver.ts) already established.
 *
 * This is a fallback, not a replacement, for `subscriptions.cancellationInstructionsUrl` — the
 * subscription-detail UI shows an evidenced URL from the source email first (a specific, first-party fact
 * about THIS user's account) and only falls back to these curated steps when no such URL was ever
 * evidenced. Absent both, the UI keeps its existing honest "not found" message — this table is never used
 * to paper over a merchant nobody has curated steps for.
 */

export interface ResolvedMerchantCancellationSteps {
  steps: string[];
  sourceNote: string | null;
  /** "user" — this caller's own correction always wins; "seeded" — the curated global reference row. */
  source: "user" | "seeded";
  stepsId: string;
}

/**
 * Precedence: a caller's own `ownerUserId`-scoped row for this merchant always outranks the global seeded
 * row, never the reverse — identical precedence rule to `resolvePriceAdjustmentPolicy`/
 * `resolveJurisdictionLink`. Returns null when `merchantId` is unset or nothing (seeded or user-corrected)
 * exists for it yet — callers treat that as "no curated steps available," never as an error, and fall back
 * to their own honest "not found" UI copy.
 */
export async function resolveMerchantCancellationSteps(
  db: Database,
  merchantId: string | null,
  ownerUserId: string,
): Promise<ResolvedMerchantCancellationSteps | null> {
  if (!merchantId) return null;
  const rows = await db
    .select()
    .from(schema.merchantCancellationSteps)
    .where(
      and(
        eq(schema.merchantCancellationSteps.merchantId, merchantId),
        or(isNull(schema.merchantCancellationSteps.ownerUserId), eq(schema.merchantCancellationSteps.ownerUserId, ownerUserId)),
      ),
    );
  if (rows.length === 0) return null;

  const userRow = rows.find((r) => r.ownerUserId === ownerUserId);
  const globalRow = rows.find((r) => r.ownerUserId === null);
  const best = userRow ?? globalRow ?? rows[0]!;
  return { steps: best.steps, sourceNote: best.sourceNote, source: best.ownerUserId ? "user" : "seeded", stepsId: best.id };
}

/**
 * Writes/updates one user's own correction/addition for a merchant's cancellation steps — upserts in place
 * (like `setUserJurisdictionLink`, unlike `setUserPriceAdjustmentPolicy`'s append-only history) since a
 * cancellation process has no "effective date" history worth preserving, just a single current best-known
 * set of steps a user is correcting or adding for a merchant nothing was seeded for.
 */
export async function setUserMerchantCancellationSteps(
  db: Database,
  ownerUserId: string,
  merchantId: string,
  input: { steps: string[]; sourceNote?: string | null },
): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: schema.merchantCancellationSteps.id })
    .from(schema.merchantCancellationSteps)
    .where(and(eq(schema.merchantCancellationSteps.merchantId, merchantId), eq(schema.merchantCancellationSteps.ownerUserId, ownerUserId)))
    .limit(1);
  if (existing) {
    await db
      .update(schema.merchantCancellationSteps)
      .set({ steps: input.steps, sourceNote: input.sourceNote ?? null, updatedAt: new Date() })
      .where(eq(schema.merchantCancellationSteps.id, existing.id));
    return { id: existing.id };
  }
  const id = generateId("merchantCancellationStep");
  await db.insert(schema.merchantCancellationSteps).values({
    id,
    merchantId,
    ownerUserId,
    steps: input.steps,
    sourceNote: input.sourceNote ?? null,
  });
  return { id };
}
