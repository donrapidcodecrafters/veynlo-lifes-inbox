import { Inject, Injectable } from "@nestjs/common";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { SharingService } from "./sharing.service";
import { PublicShareService } from "./public-share.service";

const RESOURCE_TYPE_LABELS: Record<string, string> = {
  document: "Document",
  list: "List",
  purchase: "Purchase",
  property: "Property",
  vehicle: "Vehicle",
  pet: "Pet",
  trip: "Trip",
  saved_memory: "Saved item",
  person: "Person",
  identity_record: "Identity record",
  health_appointment: "Health appointment",
};

/**
 * §35 SHARE-007 "Share audit" — "Owners can see active shares and access history... Central 'Shared by
 * me' and 'Shared with me' screens." Until now sharing state was only ever visible per-resource (open a
 * specific list/document/etc. and look at its own ShareResourcePanel) — nothing aggregated across every
 * resource type. Lives alongside PublicShareService (not SharingModule itself) for the same reason
 * PublicShareService does: it needs to know about every resource type to produce a display label, and
 * SharingModule deliberately sits at the BOTTOM of the sharing dependency graph with no knowledge of any
 * resource module (see SharingModule's own doc comment) to avoid a circular import.
 */
@Injectable()
export class SharingHubService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(PublicShareService) private readonly publicShare: PublicShareService,
  ) {}

  /**
   * Everything the current user has shared OUT: every resourceGrant they personally granted, and every
   * share_link they personally created, regardless of resource type — grouped by resourceType so the UI
   * can render one section per kind of thing. Revoked rows are excluded (a revoked grant/link isn't an
   * "active share" any more); expired-but-not-yet-revoked rows are still included since the row itself is
   * real history until something actually deletes it, same as listResourceGrants/listShareLinks's own
   * per-resource behavior.
   */
  async sharedByMe(userId: string) {
    const [grantRows, linkRows] = await Promise.all([
      this.db
        .select({ grant: schema.resourceGrants, granteeEmail: schema.users.email })
        .from(schema.resourceGrants)
        .innerJoin(schema.users, eq(schema.users.id, schema.resourceGrants.granteeUserId))
        .where(and(eq(schema.resourceGrants.grantedByUserId, userId), isNull(schema.resourceGrants.revokedAt))),
      this.db
        .select({ id: schema.shareLinks.id, resourceType: schema.shareLinks.resourceType, resourceId: schema.shareLinks.resourceId, expiresAt: schema.shareLinks.expiresAt, createdAt: schema.shareLinks.createdAt, hasPasscode: schema.shareLinks.passcodeHash })
        .from(schema.shareLinks)
        .where(and(eq(schema.shareLinks.createdByUserId, userId), isNull(schema.shareLinks.revokedAt))),
    ]);

    const grants = await Promise.all(
      grantRows.map(async (r) => ({
        kind: "grant" as const,
        id: r.grant.id,
        resourceType: r.grant.resourceType,
        resourceTypeLabel: RESOURCE_TYPE_LABELS[r.grant.resourceType] ?? r.grant.resourceType,
        resourceLabel: await this.publicShare.labelFor(r.grant.resourceType, r.grant.resourceId),
        right: r.grant.right,
        granteeEmail: r.granteeEmail,
        expiresAt: r.grant.expiresAt,
        grantedAt: r.grant.grantedAt,
      })),
    );
    const links = await Promise.all(
      linkRows.map(async (r) => ({
        kind: "share_link" as const,
        id: r.id,
        resourceType: r.resourceType,
        resourceTypeLabel: RESOURCE_TYPE_LABELS[r.resourceType] ?? r.resourceType,
        resourceLabel: await this.publicShare.labelFor(r.resourceType, r.resourceId),
        hasPasscode: r.hasPasscode != null,
        expiresAt: r.expiresAt,
        createdAt: r.createdAt,
      })),
    );
    return { grants, links };
  }

  /** Everything shared TO the current user: every active (unrevoked, unexpired) resourceGrant naming them
   * as the grantee, regardless of who granted it or what resource type it points at. Share links have no
   * "with me" side — a link isn't addressed to anyone in particular, so it has no place in this list. */
  async sharedWithMe(userId: string) {
    const rows = await this.db
      .select({ grant: schema.resourceGrants, granterEmail: schema.users.email })
      .from(schema.resourceGrants)
      .innerJoin(schema.users, eq(schema.users.id, schema.resourceGrants.grantedByUserId))
      .where(and(eq(schema.resourceGrants.granteeUserId, userId), isNull(schema.resourceGrants.revokedAt)));
    return Promise.all(
      rows.map(async (r) => ({
        id: r.grant.id,
        resourceType: r.grant.resourceType,
        resourceTypeLabel: RESOURCE_TYPE_LABELS[r.grant.resourceType] ?? r.grant.resourceType,
        resourceLabel: await this.publicShare.labelFor(r.grant.resourceType, r.grant.resourceId),
        right: r.grant.right,
        granterEmail: r.granterEmail,
        expiresAt: r.grant.expiresAt,
        grantedAt: r.grant.grantedAt,
      })),
    );
  }

  /**
   * Revoke from the hub — deliberately re-lives in SharingService's own revoke methods (not duplicated
   * here) so the exact same "only the granter, or a resource-specific manage-right check" rule applies
   * regardless of whether revocation happened from a resource's own ShareResourcePanel or from this
   * central hub. The hub only ever lets someone revoke a grant/link THEY personally created (no resource-
   * specific `isAuthorized` callback is passed — see SharingService.revokeResourceGrant/revokeShareLink's
   * own doc comment on that being the base case), which is always true for anything sharedByMe returns.
   */
  async revokeGrant(grantId: string, requestingUserId: string): Promise<void> {
    await this.sharing.revokeResourceGrant(grantId, requestingUserId);
  }

  async revokeShareLink(linkId: string, requestingUserId: string): Promise<void> {
    await this.sharing.revokeShareLink(linkId, requestingUserId);
  }
}
