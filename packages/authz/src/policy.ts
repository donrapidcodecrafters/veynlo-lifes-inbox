import { and, eq, isNull, or, gt } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import type { AccessRight, Visibility } from "@veynlo/core";

/**
 * Central authorization policy (§45.2 "Broken object authorization" threat,
 * Appendix I `authz` package). Every read/write path in the API and workers
 * must go through `resolveAccess`/`requireAccess` — deny by default, and
 * never trust a cached/indexed ACL as the final word (search re-checks here
 * at fetch time too).
 */
export interface ResourceAccessSubject {
  resourceType: string;
  resourceId: string;
  ownerUserId: string;
  householdId: string | null;
  visibility: Visibility;
}

export interface AccessDecision {
  allowed: boolean;
  right: AccessRight | null;
  reason: string;
}

const RIGHT_RANK: Record<AccessRight, number> = { view: 1, edit: 2, manage: 3 };

function rightAtLeast(have: AccessRight, need: AccessRight): boolean {
  return RIGHT_RANK[have] >= RIGHT_RANK[need];
}

export class AuthzDeniedError extends Error {
  constructor(reason: string) {
    super(`Access denied: ${reason}`);
    this.name = "AuthzDeniedError";
  }
}

/**
 * Resolves the effective access decision for `principalUserId` against a
 * resource. This does NOT handle `shared_link` visibility — that path is
 * unauthenticated-by-token and must go through `resolveShareLinkAccess`.
 */
export async function resolveAccess(
  db: Database,
  principalUserId: string,
  resource: ResourceAccessSubject,
): Promise<AccessDecision> {
  if (resource.ownerUserId === principalUserId) {
    return { allowed: true, right: "manage", reason: "owner" };
  }

  if (resource.visibility === "household" && resource.householdId) {
    const [membership] = await db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, resource.householdId),
          eq(schema.householdMemberships.userId, principalUserId),
          eq(schema.householdMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (membership) {
      return { allowed: true, right: "view", reason: "household_member" };
    }
  }

  // "selected_people" (and household-visible resources with a widened grant) both fall through to explicit grants.
  const now = new Date();
  const [grant] = await db
    .select({ right: schema.resourceGrants.right })
    .from(schema.resourceGrants)
    .where(
      and(
        eq(schema.resourceGrants.resourceType, resource.resourceType),
        eq(schema.resourceGrants.resourceId, resource.resourceId),
        eq(schema.resourceGrants.granteeUserId, principalUserId),
        isNull(schema.resourceGrants.revokedAt),
        or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, now)),
      ),
    )
    .limit(1);
  if (grant) {
    return { allowed: true, right: grant.right as AccessRight, reason: "explicit_grant" };
  }

  return { allowed: false, right: null, reason: "no_matching_grant" };
}

export async function requireAccess(
  db: Database,
  principalUserId: string,
  resource: ResourceAccessSubject,
  minimumRight: AccessRight = "view",
): Promise<AccessDecision> {
  const decision = await resolveAccess(db, principalUserId, resource);
  if (!decision.allowed || !decision.right || !rightAtLeast(decision.right, minimumRight)) {
    throw new AuthzDeniedError(decision.reason);
  }
  return decision;
}

/** HH-006/PRIV — resolves access via a scoped share-link token rather than a logged-in principal. */
export async function resolveShareLinkAccess(
  db: Database,
  tokenHash: string,
  passcodeHash: string | null,
): Promise<{ allowed: boolean; resourceType: string | null; resourceId: string | null; reason: string }> {
  const [link] = await db
    .select()
    .from(schema.shareLinks)
    .where(eq(schema.shareLinks.tokenHash, tokenHash))
    .limit(1);
  if (!link || link.revokedAt) {
    return { allowed: false, resourceType: null, resourceId: null, reason: "not_found_or_revoked" };
  }
  if (link.expiresAt && link.expiresAt < new Date()) {
    return { allowed: false, resourceType: null, resourceId: null, reason: "expired" };
  }
  if (link.passcodeHash && link.passcodeHash !== passcodeHash) {
    return { allowed: false, resourceType: null, resourceId: null, reason: "passcode_required" };
  }
  return { allowed: true, resourceType: link.resourceType, resourceId: link.resourceId, reason: "share_link" };
}
