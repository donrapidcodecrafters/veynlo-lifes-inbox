import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { generateId, canCreateShareLink, type SensitivityTier } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { recordAuditEvent } from "../../common/audit";

const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Static tier for the two resourceTypes with no per-row sensitivity column of their own (matching this
// codebase's own Appendix C examples: "calendar titles" is explicitly a "sensitive"-tier item; attention
// items are summaries/reasons drawn from those same domains, not raw financial/identity/health data).
// `document` instead reads the row's own real `sensitivity` column below, since that varies per document.
const STATIC_RESOURCE_SENSITIVITY: Record<string, SensitivityTier> = {
  attention_item: "sensitive",
  calendar_event: "sensitive",
};

/**
 * §Sharing expansion — the token/hash/expiry mechanics behind every "share" action (previously inlined
 * once, in AttentionService, as the only caller). Generic over `resourceType`/`resourceId`; the caller is
 * responsible for its own ownership check before calling either method here (each domain service already
 * has its own assertOwned*-style helper, and what "owns this" means differs per resource type). No
 * passcode support exposed here (the schema/authz layer already supports one) — a defensible MVP cut
 * given the link itself is a long random token, expires in 7 days, and is always revocable.
 */
@Injectable()
export class SharingService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** SECURITY.md "consumer-side actions aren't all audited yet" — sharing changes were one of the named gaps. */
  private async recordAudit(actorUserId: string, action: string, resourceType: string, resourceId: string) {
    await recordAuditEvent(this.db, { actorType: "user", actorId: actorUserId, action, resourceType, resourceId });
  }

  /**
   * §45.4 "highly sensitive categories can disallow public share links entirely" — canCreateShareLink
   * existed in packages/core with exactly that doc comment, but nothing here ever actually called it; a
   * real gap, not just dead code, since it's the one guard this specific method's own class doc singles
   * out. Every resourceType this method is ever actually called with today resolves to "sensitive" (the
   * static map below, or a document's own real `sensitivity` column, which is itself always "sensitive"
   * until per-document classification exists) — so this doesn't change today's behavior for any real
   * caller, but it's the correct, real check going forward rather than an unenforced comment.
   */
  private async assertShareLinkAllowed(resourceType: string, resourceId: string): Promise<void> {
    let tier: SensitivityTier;
    if (resourceType === "document") {
      const [doc] = await this.db.select({ sensitivity: schema.documents.sensitivity }).from(schema.documents).where(eq(schema.documents.id, resourceId)).limit(1);
      tier = doc?.sensitivity ?? "sensitive";
    } else {
      tier = STATIC_RESOURCE_SENSITIVITY[resourceType] ?? "sensitive";
    }
    if (!canCreateShareLink(tier)) {
      throw new BadRequestException({
        code: "SHARE_LINK_NOT_ALLOWED",
        message: "This item is too sensitive to share via a public link.",
      });
    }
  }

  /** Returns the plaintext token exactly once, inside the URL — only its hash is ever stored. */
  async createShareLink(resourceType: string, resourceId: string, userId: string): Promise<{ url: string }> {
    await this.assertShareLinkAllowed(resourceType, resourceId);
    const token = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await this.db.insert(schema.shareLinks).values({
      id: generateId("shareLink"),
      resourceType,
      resourceId,
      tokenHash,
      createdByUserId: userId,
      expiresAt: new Date(Date.now() + SHARE_LINK_TTL_MS),
    });
    await this.recordAudit(userId, "share.create", resourceType, resourceId);
    return { url: `${loadEnv().WEB_APP_URL}/shared/${token}` };
  }

  async revokeShareLinks(resourceType: string, resourceId: string, userId: string): Promise<void> {
    await this.db
      .update(schema.shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareLinks.resourceType, resourceType), eq(schema.shareLinks.resourceId, resourceId), isNull(schema.shareLinks.revokedAt)));
    await this.recordAudit(userId, "share.revoke", resourceType, resourceId);
  }

  /** "Shared by me" audit view — every link this user has ever created, active or not. There's no
   * meaningful "shared with me" counterpart: a share link is a bearer token (anyone with the URL), not an
   * account-level grant, so there's no user identity to list it against on the recipient side. */
  async listMyShareLinks(userId: string) {
    return this.db.select().from(schema.shareLinks).where(eq(schema.shareLinks.createdByUserId, userId)).orderBy(desc(schema.shareLinks.createdAt));
  }

  async revokeShareLinkById(shareLinkId: string, userId: string): Promise<void> {
    await this.db
      .update(schema.shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareLinks.id, shareLinkId), eq(schema.shareLinks.createdByUserId, userId), isNull(schema.shareLinks.revokedAt)));
    await this.recordAudit(userId, "share.revoke", "share_link", shareLinkId);
  }

  /**
   * SHARE-001 "direct object sharing to a specific household member" — resource_grants existed and was
   * READ by packages/authz/policy.ts's resolveAccess, but nothing anywhere ever wrote a row to it; this is
   * that writer. Distinct from a share link (a long-lived bearer token anyone with the URL can use) — this
   * grants one specific account real, revocable access. Caller is responsible for its own ownership check
   * and for validating granteeUserId is a real active member of the resource's household, same "caller
   * already checked" contract as createShareLink/revokeShareLinks above.
   */
  async grantAccess(resourceType: string, resourceId: string, granteeUserId: string, grantedByUserId: string): Promise<{ id: string }> {
    const id = generateId("resourceGrant");
    await this.db.insert(schema.resourceGrants).values({ id, resourceType, resourceId, granteeUserId, right: "view", grantedByUserId });
    await this.recordAudit(grantedByUserId, "share.grant", resourceType, resourceId);
    return { id };
  }

  /** Only the grant's original creator can revoke it — mirrors revokeShareLinkById's own creator-scoped shape. */
  async revokeGrant(grantId: string, userId: string): Promise<void> {
    await this.db
      .update(schema.resourceGrants)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.resourceGrants.id, grantId), eq(schema.resourceGrants.grantedByUserId, userId), isNull(schema.resourceGrants.revokedAt)));
    await this.recordAudit(userId, "share.revoke_grant", "resource_grant", grantId);
  }

  async listGrants(resourceType: string, resourceId: string) {
    return this.db
      .select()
      .from(schema.resourceGrants)
      .where(and(eq(schema.resourceGrants.resourceType, resourceType), eq(schema.resourceGrants.resourceId, resourceId), isNull(schema.resourceGrants.revokedAt)));
  }

  /** The real enforcement side — a domain service's own read-access check calls this alongside its
   * existing owner/household-delegate checks to decide whether a specific non-owner user can view this
   * exact resource. */
  async hasActiveGrant(resourceType: string, resourceId: string, granteeUserId: string): Promise<boolean> {
    const now = new Date();
    const [row] = await this.db
      .select({ id: schema.resourceGrants.id })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceType, resourceType),
          eq(schema.resourceGrants.resourceId, resourceId),
          eq(schema.resourceGrants.granteeUserId, granteeUserId),
          isNull(schema.resourceGrants.revokedAt),
          or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, now)),
        ),
      )
      .limit(1);
    return Boolean(row);
  }
}
