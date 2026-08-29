import { Inject, Injectable } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";

const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

  /** SECURITY.md "consumer-side actions aren't all audited yet" — sharing changes were one of the named
   * gaps. Mirrors HouseholdService.recordAudit's exact shape (actor/action/resource/result), duplicated
   * rather than shared — this codebase already has two independent copies of this same small helper
   * (here and in AdminService), not one shared abstraction, and a third follows that established pattern. */
  private async recordAudit(actorUserId: string, action: string, resourceType: string, resourceId: string) {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: actorUserId,
      action,
      resourceType,
      resourceId,
      result: "success",
    });
  }

  /** Returns the plaintext token exactly once, inside the URL — only its hash is ever stored. */
  async createShareLink(resourceType: string, resourceId: string, userId: string): Promise<{ url: string }> {
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
}
