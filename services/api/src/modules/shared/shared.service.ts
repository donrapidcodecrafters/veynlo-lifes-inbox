import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { resolveShareLinkAccess } from "@veynlo/authz";
import { DATABASE } from "../../database/database.module";

/**
 * HOME-001 "share" redemption — the public (unauthenticated) side of AttentionService.createShareLink.
 * `resolveShareLinkAccess` (packages/authz) already existed with zero real caller anywhere before this;
 * this is that caller. Deliberately returns only what's safe to hand to an anonymous link visitor
 * (reason text, urgency, due date, money at stake) — never ownerUserId, householdId, or any other
 * account-identifying field.
 */
@Injectable()
export class SharedService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async resolve(token: string) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const access = await resolveShareLinkAccess(this.db, tokenHash, null);
    if (!access.allowed || access.resourceType !== "attention_item" || !access.resourceId) {
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }

    const [item] = await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.id, access.resourceId)).limit(1);
    if (!item || item.resolved) {
      throw new NotFoundException({ code: "SHARE_LINK_INVALID", message: "This link is invalid, expired, or has been revoked." });
    }

    return {
      reasonText: item.reasonText,
      urgency: item.urgency,
      dueAt: item.dueAt,
      moneyAtStakeMinorUnits: item.moneyAtStakeMinorUnits,
      moneyAtStakeCurrency: item.moneyAtStakeCurrency,
    };
  }
}
