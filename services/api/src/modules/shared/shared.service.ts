import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { resolveShareLinkAccess } from "@veynlo/authz";
import { DATABASE } from "../../database/database.module";
import { recordAuditEvent } from "../../common/audit";
import { StorageService } from "../documents/storage.service";

/**
 * HOME-001 "share" redemption — the public (unauthenticated) side of every domain service's
 * createShareLink (AttentionService originally, now also DocumentsService/ScheduleService).
 * `resolveShareLinkAccess` (packages/authz) already existed with zero real caller anywhere before this;
 * this is that caller. Deliberately returns only what's safe to hand to an anonymous link visitor —
 * never ownerUserId, householdId, or any other account-identifying field — with a per-resourceType
 * shape below. The share link itself IS the authorization here, so this reads the resource row directly
 * rather than going through each service's own owner-scoped assertOwned-style methods.
 */
@Injectable()
export class SharedService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly storage: StorageService,
  ) {}

  /**
   * SECURITY.md "consumer-side actions aren't all audited yet" — resolve() (the only place a public share
   * link is actually redeemed) had ZERO audit logging; only create/revoke were logged. If a link leaked,
   * there was no record it was ever accessed. Logs every attempt — the anonymous visitor has no userId, so
   * actorType is "anonymous"/actorId null; a denied attempt has no real resourceId to log against (the
   * token lookup itself failed), so it's logged against the token's own hash instead, which still gives
   * real forensic value for detecting a leaked/brute-forced link. */
  private async recordAccess(action: "share_link.resolve", resourceType: string, resourceId: string, result: "success" | "denied") {
    await recordAuditEvent(this.db, { actorType: "anonymous", actorId: null, action, resourceType, resourceId, result });
  }

  async resolve(token: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const access = await resolveShareLinkAccess(this.db, tokenHash, null);
    if (!access.allowed || !access.resourceId) {
      await this.recordAccess("share_link.resolve", "share_link_token", tokenHash, "denied");
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }

    if (access.resourceType !== "attention_item" && access.resourceType !== "document" && access.resourceType !== "calendar_event") {
      await this.recordAccess("share_link.resolve", access.resourceType ?? "unknown", access.resourceId, "denied");
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }

    await this.recordAccess("share_link.resolve", access.resourceType, access.resourceId, "success");
    if (access.resourceType === "attention_item") return this.resolveAttentionItem(access.resourceId);
    if (access.resourceType === "document") return this.resolveDocument(access.resourceId);
    return this.resolveCalendarEvent(access.resourceId);
  }

  private async resolveAttentionItem(id: string) {
    const [item] = await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.id, id)).limit(1);
    if (!item || item.resolved) {
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }
    return {
      resourceType: "attention_item" as const,
      reasonText: item.reasonText,
      urgency: item.urgency,
      dueAt: item.dueAt,
      moneyAtStakeMinorUnits: item.moneyAtStakeMinorUnits,
      moneyAtStakeCurrency: item.moneyAtStakeCurrency,
    };
  }

  private async resolveDocument(id: string) {
    const [doc] = await this.db.select().from(schema.documents).where(eq(schema.documents.id, id)).limit(1);
    if (!doc || doc.deletedAt || !doc.currentVersionId) {
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }
    const [version] = await this.db.select().from(schema.documentVersions).where(eq(schema.documentVersions.id, doc.currentVersionId)).limit(1);
    const downloadUrl = version ? await this.storage.signedGetUrl(version.blobRef).catch(() => null) : null;
    return {
      resourceType: "document" as const,
      title: doc.title,
      documentType: doc.documentType,
      downloadUrl,
    };
  }

  private async resolveCalendarEvent(id: string) {
    const [event] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).limit(1);
    if (!event) {
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }
    return {
      resourceType: "calendar_event" as const,
      title: event.title,
      start: event.start,
      end: event.end,
      isAllDay: event.isAllDay,
      location: event.location,
    };
  }
}
