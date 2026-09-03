import { createHash, randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { CreateShareLinkDto, ResourceGrantRight } from "./dto";

/** SHARE-001 "Set view/edit/manage" — strength ordering used by hasGrantAtLeast, so "does this grant meet
 * the bar" is a single numeric comparison rather than a chain of `===` checks at every call site. */
const RIGHT_RANK: Record<ResourceGrantRight, number> = { view: 0, edit: 1, manage: 2 };

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002). Extracted from what used to be
 * DocumentsService's own private grant/share-link methods — `resourceGrants`/`shareLinks`
 * (packages/db/src/schema/household.ts) were always polymorphic in schema (`resourceType`/`resourceId`
 * columns, a generic index on the pair), but every real write site hardcoded `resourceType: "document"`.
 * This service knows nothing about what a "document", "list", "purchase", "property", or "vehicle" IS —
 * only the grant/link mechanics (who granted what to whom, token/passcode hashing, expiry/revocation).
 *
 * Each resource-owning service (DocumentsService, ListsService, CommerceService, AssetsService) is
 * responsible for its own resource-specific business rules before/after delegating here:
 *   - verifying the caller actually owns the resource before granting/creating a link (this service has
 *     no resource table to check ownership against — grant/link revocation is the one case that needs no
 *     such check, since a grant/link row already carries who created it);
 *   - any resource-specific gate on public links (e.g. DocumentsService/AssetsService's sensitivity-tier
 *     check — "highly_sensitive"/"secret" content can't get a public link at all; PURCHASE/LIST have no
 *     sensitivity column, so no such gate applies to them);
 *   - resolving a validated (resourceType, resourceId) pair from resolveShareLink into an actual,
 *     redacted, read-only payload for the public redemption page (see each service's own
 *     `publicShareContent`/`publicPropertyContent`/`publicVehicleContent`, dispatched from
 *     PublicShareService).
 */
@Injectable()
export class SharingService {
  private dummyPasscodeHashCache: Promise<string> | null = null;

  /** Computed once per process and cached — see resolveShareLink's own doc comment for why an invalid
   * token still needs a real argon2 hash to verify against. */
  private dummyPasscodeHash(): Promise<string> {
    if (!this.dummyPasscodeHashCache) this.dummyPasscodeHashCache = argon2.hash(randomBytes(16).toString("hex"));
    return this.dummyPasscodeHashCache;
  }

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /** Resource ids of a given type actively (not revoked/expired) granted to `userId`, regardless of
   * resource ownership/household. Used by each resource's own list()-shaped method to OR grant-based
   * access in alongside owner/household visibility (mirrors DocumentsService.list's original shape). */
  async grantedResourceIds(resourceType: string, userId: string): Promise<string[]> {
    const rows = await this.db
      .select({ resourceId: schema.resourceGrants.resourceId })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceType, resourceType),
          eq(schema.resourceGrants.granteeUserId, userId),
          isNull(schema.resourceGrants.revokedAt),
          or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, new Date()))!,
        ),
      );
    return rows.map((r) => r.resourceId);
  }

  /**
   * §35 SHARE-004/007 "access_audit" — the one call every resource module's own single-object read path
   * (assertListAccess, assertOwned*, etc.) already makes to decide "does this non-owner, non-household
   * grantee get to see this," which makes it the natural, single choke point for recording that a grant-
   * gated view actually happened. Deliberately NOT hooked into `grantRight`/`hasGrantAtLeast` — those are
   * also used to authorize revoking a grant/link (see e.g. ListsService.revokeResourceGrant's callback),
   * which is a management action, not a view, and would otherwise pollute "who's viewed this" with entries
   * for someone merely checking whether they're allowed to revoke something. Fire-and-forget-shaped (not
   * awaited by the caller's return value) would risk losing the write if the process exits right after;
   * awaited here so a failure surfaces the same way any other DB write failure would, but never blocks on
   * more than one extra insert.
   */
  async hasActiveGrant(resourceType: string, resourceId: string, userId: string): Promise<boolean> {
    const [grant] = await this.db
      .select({ id: schema.resourceGrants.id })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceType, resourceType),
          eq(schema.resourceGrants.resourceId, resourceId),
          eq(schema.resourceGrants.granteeUserId, userId),
          isNull(schema.resourceGrants.revokedAt),
          or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, new Date()))!,
        ),
      )
      .limit(1);
    if (!grant) return false;
    await this.recordAccess(resourceType, resourceId, "grant", { accessedByUserId: userId, resourceGrantId: grant.id });
    return true;
  }

  /**
   * Explicit escape hatch for a resource module whose own read gate doesn't go through `hasActiveGrant`
   * above — today, only PeopleService.assertAccess, which (unlike every other resource's plain "is there
   * any active grant" check) needs to know the grant's `right` even for a read (view vs. edit visibility),
   * so it calls `hasGrantAtLeast` directly instead. The caller is responsible for calling this only from
   * the branch where a genuine content view (not a write/manage-authorization check) is happening — see
   * PeopleService.assertAccess's own call site.
   */
  async recordGrantAccess(resourceType: string, resourceId: string, userId: string): Promise<void> {
    await this.recordAccess(resourceType, resourceId, "grant", { accessedByUserId: userId });
  }

  /**
   * Escape hatch for an anonymous, token-based redemption that isn't a `shareLinks` row at all — today,
   * only CaregiverDayPassService.access, which mints/checks its own token the same way but stores it on
   * `caregiverDayPasses` rather than `shareLinks` (see that table's own schema doc comment for why it's a
   * separate table). Same "no authenticated identity to attach" reasoning as resolveShareLink's own
   * accessedByUserId: null.
   */
  async recordAnonymousAccess(resourceType: string, resourceId: string): Promise<void> {
    await this.recordAccess(resourceType, resourceId, "day_pass", {});
  }

  /** Shared insert behind hasActiveGrant/resolveShareLink/recordGrantAccess/recordAnonymousAccess — see
   * accessAuditEvents' own doc comment (packages/db/src/schema/sharing.ts) for exactly what this table is
   * and isn't for. */
  private async recordAccess(
    resourceType: string,
    resourceId: string,
    accessMethod: "grant" | "share_link" | "day_pass",
    extra: { accessedByUserId?: string; resourceGrantId?: string; shareLinkId?: string },
  ): Promise<void> {
    await this.db.insert(schema.accessAuditEvents).values({
      id: generateId("accessAuditEvent"),
      resourceType,
      resourceId,
      accessMethod,
      accessedByUserId: extra.accessedByUserId ?? null,
      resourceGrantId: extra.resourceGrantId ?? null,
      shareLinkId: extra.shareLinkId ?? null,
    });
  }

  /**
   * SHARE-007 "Owners can see active shares and access history" — read side of the ledger `hasActiveGrant`/
   * `resolveShareLink` write into. Ownership/manage-right authorization is each resource module's own
   * responsibility (same split as listResourceGrants/listShareLinks above) — this just returns the rows.
   */
  async listAccessEvents(resourceType: string, resourceId: string) {
    const rows = await this.db
      .select({ event: schema.accessAuditEvents, accessedByEmail: schema.users.email })
      .from(schema.accessAuditEvents)
      .leftJoin(schema.users, eq(schema.users.id, schema.accessAuditEvents.accessedByUserId))
      .where(and(eq(schema.accessAuditEvents.resourceType, resourceType), eq(schema.accessAuditEvents.resourceId, resourceId)))
      .orderBy(desc(schema.accessAuditEvents.accessedAt))
      .limit(100);
    return rows.map((r) => ({
      id: r.event.id,
      accessMethod: r.event.accessMethod,
      accessedAt: r.event.accessedAt,
      accessedByEmail: r.accessedByEmail ?? null,
    }));
  }

  /**
   * SHARE-001 "Set view/edit/manage" — the enforcement half that was previously entirely missing: every
   * write path across Lists/Commerce/Assets/Pets used to gate purely on `ownerUserId === userId` (or plain
   * household membership), so a grant's `right` column existed but nothing ever read it back. Returns the
   * active grant's right, or null when there's no active (unrevoked, unexpired) grant at all — same
   * active-grant filter as hasActiveGrant, just also selecting the column that matters for write access.
   */
  async grantRight(resourceType: string, resourceId: string, userId: string): Promise<ResourceGrantRight | null> {
    const [grant] = await this.db
      .select({ right: schema.resourceGrants.right })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceType, resourceType),
          eq(schema.resourceGrants.resourceId, resourceId),
          eq(schema.resourceGrants.granteeUserId, userId),
          isNull(schema.resourceGrants.revokedAt),
          or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, new Date()))!,
        ),
      )
      .limit(1);
    return (grant?.right as ResourceGrantRight | undefined) ?? null;
  }

  /** True when `userId` holds an active grant on this resource whose right is AT LEAST `requiredRight`
   * (view < edit < manage — see RIGHT_RANK). This is the one call every resource service's write path
   * should make to decide whether a grantee (as opposed to the owner or a household member) may act. */
  async hasGrantAtLeast(resourceType: string, resourceId: string, userId: string, requiredRight: ResourceGrantRight): Promise<boolean> {
    const right = await this.grantRight(resourceType, resourceId, userId);
    return right != null && RIGHT_RANK[right] >= RIGHT_RANK[requiredRight];
  }

  /** The message (if any) attached to userId's active grant on this resource — surfaced by each resource's
   * own detail method as a "Note from the owner" banner for a grantee. Null both when there's no active
   * grant and when there is one but no message was set. */
  async grantMessage(resourceType: string, resourceId: string, userId: string): Promise<string | null> {
    const [grant] = await this.db
      .select({ message: schema.resourceGrants.message })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceType, resourceType),
          eq(schema.resourceGrants.resourceId, resourceId),
          eq(schema.resourceGrants.granteeUserId, userId),
          isNull(schema.resourceGrants.revokedAt),
          or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, new Date()))!,
        ),
      )
      .limit(1);
    return grant?.message ?? null;
  }

  /**
   * Owner-only by convention (enforced by the caller, not here — see this class's own doc comment):
   * sharing an object is a right of the resource's owner, not a household-delegated caregiver (FAM-006
   * delegation is about viewing/managing someone else's whole household context, not re-sharing their
   * individual objects to a third party). Resolves by email since that's what an owner actually knows
   * about who they want to share with; the grantee must already have a Veynlo account.
   */
  async createResourceGrant(
    resourceType: string,
    resourceId: string,
    grantedByUserId: string,
    granteeEmail: string,
    expiresInDays?: number,
    right: ResourceGrantRight = "view",
    message?: string,
  ): Promise<{ id: string }> {
    const [grantee] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, granteeEmail.toLowerCase())).limit(1);
    if (!grantee) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "No Veynlo account found for that email." });
    if (grantee.id === grantedByUserId) throw new BadRequestException({ code: "CANNOT_SHARE_WITH_SELF", message: "You already have access to this." });

    const id = generateId("resourceGrant");
    await this.db.insert(schema.resourceGrants).values({
      id,
      resourceType,
      resourceId,
      granteeUserId: grantee.id,
      right,
      message: message?.trim() || null,
      grantedByUserId,
      expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
    });
    return { id };
  }

  async listResourceGrants(resourceType: string, resourceId: string) {
    return this.db
      .select({ grant: schema.resourceGrants, granteeEmail: schema.users.email })
      .from(schema.resourceGrants)
      .innerJoin(schema.users, eq(schema.users.id, schema.resourceGrants.granteeUserId))
      .where(and(eq(schema.resourceGrants.resourceType, resourceType), eq(schema.resourceGrants.resourceId, resourceId), isNull(schema.resourceGrants.revokedAt)));
  }

  /**
   * No resourceType/resourceId needed for the base case — a grant row already carries who created it, so
   * the default rule ("you can revoke what you personally granted") is fully generic regardless of what
   * kind of resource it points to. `isAuthorized`, when passed, is an escape hatch for SHARE-001's "manage"
   * right: a resource-owning service that wants to also let its current owner (or another "manage"-right
   * grantee) revoke a grant they didn't personally create passes a callback that inspects the grant's own
   * (resourceType, resourceId) and decides — this service still owns the actual revoke/authorization
   * ordering, it just can't check resource ownership itself (it has no resource tables of its own, see this
   * class's own doc comment).
   */
  async revokeResourceGrant(grantId: string, requestingUserId: string, isAuthorized?: (resourceType: string, resourceId: string) => Promise<boolean>): Promise<void> {
    const [grant] = await this.db.select().from(schema.resourceGrants).where(eq(schema.resourceGrants.id, grantId)).limit(1);
    if (!grant) throw new NotFoundException({ code: "GRANT_NOT_FOUND", message: "Not found." });
    if (grant.grantedByUserId !== requestingUserId) {
      const authorized = isAuthorized ? await isAuthorized(grant.resourceType, grant.resourceId) : false;
      if (!authorized) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your grant to revoke." });
    }
    await this.db.update(schema.resourceGrants).set({ revokedAt: new Date() }).where(eq(schema.resourceGrants.id, grantId));
  }

  /**
   * Phase 2 §52.2 "object sharing" (spec SHARE-002 "secure external link") — the raw token is returned
   * exactly once, here, and never again; only its SHA-256 hash is stored (the token is high-entropy
   * random, unlike a user-chosen passcode, so a fast hash is the right tool). The optional passcode uses
   * argon2 instead, since a user-chosen passcode can be low-entropy and deserves real password hashing.
   * Any resource-specific gate on whether a public link is even allowed (e.g. a sensitivity-tier check)
   * is the caller's responsibility, checked before this is ever reached.
   */
  async createShareLink(resourceType: string, resourceId: string, createdByUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    const token = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const passcodeHash = dto.passcode ? await argon2.hash(dto.passcode) : null;
    const id = generateId("shareLink");
    await this.db.insert(schema.shareLinks).values({
      id,
      resourceType,
      resourceId,
      tokenHash,
      createdByUserId,
      passcodeHash,
      expiresAt: dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null,
    });
    return { id, token };
  }

  async listShareLinks(resourceType: string, resourceId: string) {
    // tokenHash/passcodeHash are deliberately never returned — the list view only needs to show that a
    // link exists and let the owner revoke it, never the secret itself (already shown once, at creation).
    const rows = await this.db
      .select({ id: schema.shareLinks.id, expiresAt: schema.shareLinks.expiresAt, createdAt: schema.shareLinks.createdAt, passcodeHash: schema.shareLinks.passcodeHash })
      .from(schema.shareLinks)
      .where(and(eq(schema.shareLinks.resourceType, resourceType), eq(schema.shareLinks.resourceId, resourceId), isNull(schema.shareLinks.revokedAt)));
    return rows.map((r) => ({ id: r.id, expiresAt: r.expiresAt, createdAt: r.createdAt, hasPasscode: r.passcodeHash != null }));
  }

  /** No resourceType/resourceId needed for the base case, same reasoning as revokeResourceGrant; `isAuthorized` is the same "manage"-right escape hatch. */
  async revokeShareLink(linkId: string, requestingUserId: string, isAuthorized?: (resourceType: string, resourceId: string) => Promise<boolean>): Promise<void> {
    const [link] = await this.db.select().from(schema.shareLinks).where(eq(schema.shareLinks.id, linkId)).limit(1);
    if (!link) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "Not found." });
    if (link.createdByUserId !== requestingUserId) {
      const authorized = isAuthorized ? await isAuthorized(link.resourceType, link.resourceId) : false;
      if (!authorized) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your share link to revoke." });
    }
    await this.db.update(schema.shareLinks).set({ revokedAt: new Date() }).where(eq(schema.shareLinks.id, linkId));
  }

  /**
   * Public, unauthenticated path (spec SHARE-002: "expiring link for selected... content without
   * requiring account"). Revalidates revocation/expiry/passcode on every access, not just at creation.
   * Never reveals WHY access failed beyond "not found" for an unknown/expired/revoked token (a
   * distinguishable "wrong passcode" vs "bad token" response would let an attacker enumerate valid
   * tokens) — except the one case a legitimate accessor needs to recover from: an existing, unexpired
   * link that simply needs its passcode entered.
   *
   * That "never reveals WHY" guarantee is also not timing-observable: an unknown token could otherwise
   * return immediately (one indexed SELECT), while a real token's wrong-passcode path always pays
   * argon2's deliberately-slow verify cost — letting an attacker measure response latency to learn "this
   * token exists" before ever needing a passcode to test against it. The invalid-token path pays that
   * same argon2 cost against a dummy hash before rejecting, so latency alone can't distinguish the two
   * cases either.
   *
   * Deliberately returns just the resolved (resourceType, resourceId) — this service has no idea how to
   * render a document vs. a list vs. a purchase; PublicShareService dispatches on resourceType to the
   * owning service's own `publicShareContent`-shaped method to fetch the actual, redacted content.
   */
  async resolveShareLink(token: string, passcode: string | undefined): Promise<{ resourceType: string; resourceId: string }> {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const [link] = await this.db.select().from(schema.shareLinks).where(eq(schema.shareLinks.tokenHash, tokenHash)).limit(1);
    if (!link || link.revokedAt || (link.expiresAt && link.expiresAt < new Date())) {
      await argon2.verify(await this.dummyPasscodeHash(), passcode ?? "");
      throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    }
    if (link.passcodeHash) {
      if (!passcode || !(await argon2.verify(link.passcodeHash, passcode))) {
        throw new ForbiddenException({ code: "PASSCODE_REQUIRED", message: "This link needs a passcode." });
      }
    }
    // §35 SHARE-004/007 "access_audit" — accessedByUserId is deliberately always null here: a share link's
    // whole point is that the recipient need not be signed in at all (see this method's own doc comment),
    // so there is no authenticated identity to attach even if the visitor happens to have a Veynlo session
    // open in another tab. The link itself (shareLinkId) is the only identity this access can ever carry.
    await this.recordAccess(link.resourceType, link.resourceId, "share_link", { shareLinkId: link.id });
    return { resourceType: link.resourceType, resourceId: link.resourceId };
  }

  /**
   * HH-002 "Each object shows a privacy badge: ... Selected People, Shared Link." Generic half of what
   * used to be DocumentsService's own `computeSharingStates` — whether a household-visibility badge
   * additionally applies (documents' "household" state) is resource-specific and layered on by the
   * caller, since only some resources (documents, properties, vehicles) have a household-visibility
   * concept distinguishable from plain grants. Precedence (broadest-exposure wins): an active public
   * share link outranks a direct grant.
   */
  async computeSharingStates(resourceType: string, resourceIds: string[]): Promise<Map<string, "selected_people" | "shared_link">> {
    const result = new Map<string, "selected_people" | "shared_link">();
    if (resourceIds.length === 0) return result;
    const now = new Date();

    const grantRows = await this.db
      .select({ resourceId: schema.resourceGrants.resourceId })
      .from(schema.resourceGrants)
      .where(
        and(
          eq(schema.resourceGrants.resourceType, resourceType),
          inArray(schema.resourceGrants.resourceId, resourceIds),
          isNull(schema.resourceGrants.revokedAt),
          or(isNull(schema.resourceGrants.expiresAt), gt(schema.resourceGrants.expiresAt, now))!,
        ),
      );
    for (const row of grantRows) result.set(row.resourceId, "selected_people");

    const linkRows = await this.db
      .select({ resourceId: schema.shareLinks.resourceId })
      .from(schema.shareLinks)
      .where(
        and(
          eq(schema.shareLinks.resourceType, resourceType),
          inArray(schema.shareLinks.resourceId, resourceIds),
          isNull(schema.shareLinks.revokedAt),
          or(isNull(schema.shareLinks.expiresAt), gt(schema.shareLinks.expiresAt, now))!,
        ),
      );
    for (const row of linkRows) result.set(row.resourceId, "shared_link");

    return result;
  }
}
