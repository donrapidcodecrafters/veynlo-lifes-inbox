import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { desc, eq, isNull, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

/** Strips punctuation/casing/common corporate suffixes so "Amazon.com", "AMAZON MKTPLACE PMTS", and "Amazon, Inc." group together. */
function normalizeMerchantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(com|net|org|co)\b/g, "")
    .replace(/\b(inc|llc|ltd|corp|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

@Injectable()
export class AdminService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findUserByEmail(email: string, actingAdminId: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    // Every support lookup is audited regardless of hit/miss — a support agent probing for an email
    // that doesn't exist is still access-worth-recording (§45 "least privilege... audited access").
    await this.recordAccess(actingAdminId, "admin.user_lookup", "user", user?.id ?? email);
    if (!user) return null;

    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, user.id));
    const entitlements = await this.db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, user.id));
    // Support tooling intentionally exposes only metadata (status, plan, connector health) — never message/document
    // bodies or financial details (§ "ADMIN SUPPORT ACCESS": "prefer metadata... redacted views").
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      createdAt: user.createdAt,
      connections: connections.map((c) => ({ id: c.id, provider: c.provider, health: c.health, lastSuccessfulSyncAt: c.lastSuccessfulSyncAt })),
      entitlements,
    };
  }

  async connectorHealthSummary() {
    const connections = await this.db.select().from(schema.connections).where(ne(schema.connections.health, "disconnected"));
    const byHealth: Record<string, number> = {};
    for (const c of connections) byHealth[c.health] = (byHealth[c.health] ?? 0) + 1;
    return { total: connections.length, byHealth };
  }

  async recentAuditEvents(limit = 50) {
    return this.db.select().from(schema.auditEvents).orderBy(desc(schema.auditEvents.occurredAt)).limit(limit);
  }

  /** Only active (not already merged away) merchants — a merged-away row is history, not a live entity to browse/merge again. */
  async listMerchants() {
    return this.db.select().from(schema.merchants).where(isNull(schema.merchants.mergedIntoMerchantId)).orderBy(schema.merchants.displayName);
  }

  /**
   * Groups active merchants by a normalized name so an admin can spot
   * likely duplicates ("Amazon.com" / "AMAZON MKTPLACE PMTS" / "Amazon,
   * Inc.") without hand-searching — a heuristic surfaced for a human to
   * confirm, never an automatic merge (§entity-resolution: merges are
   * reviewed, not silently applied).
   */
  async findDuplicateMerchantCandidates() {
    const merchants = await this.listMerchants();
    const groups = new Map<string, typeof merchants>();
    for (const merchant of merchants) {
      const key = normalizeMerchantName(merchant.displayName);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(merchant);
      else groups.set(key, [merchant]);
    }
    return [...groups.values()].filter((group) => group.length > 1);
  }

  async listMerchantMergeLineage(limit = 50) {
    return this.db
      .select()
      .from(schema.merchantMergeLineage)
      .orderBy(desc(schema.merchantMergeLineage.mergedAt))
      .limit(limit);
  }

  /**
   * Merges `mergedMerchantId` into `survivingMerchantId`: repoints every
   * purchase from the merged merchant to the surviving one, snapshots the
   * merged row (for a clean `unmergeMerchants` restore) instead of hard-
   * deleting it, and records exactly which purchases were repointed so
   * unmerge only reverses this merge's effects — not any purchases
   * legitimately added to the surviving merchant afterward.
   */
  async mergeMerchants(survivingMerchantId: string, mergedMerchantId: string, actorAdminId: string) {
    if (survivingMerchantId === mergedMerchantId) {
      throw new BadRequestException({ code: "SAME_MERCHANT", message: "Cannot merge a merchant into itself." });
    }
    const [surviving] = await this.db.select().from(schema.merchants).where(eq(schema.merchants.id, survivingMerchantId)).limit(1);
    const [merged] = await this.db.select().from(schema.merchants).where(eq(schema.merchants.id, mergedMerchantId)).limit(1);
    if (!surviving || !merged) {
      throw new NotFoundException({ code: "MERCHANT_NOT_FOUND", message: "One or both merchants were not found." });
    }
    if (merged.mergedIntoMerchantId) {
      throw new BadRequestException({ code: "ALREADY_MERGED", message: "That merchant was already merged into another one." });
    }

    const repointed = await this.db
      .select({ id: schema.purchases.id })
      .from(schema.purchases)
      .where(eq(schema.purchases.merchantId, mergedMerchantId));
    const repointedPurchaseIds = repointed.map((p) => p.id);

    await this.db.update(schema.purchases).set({ merchantId: survivingMerchantId }).where(eq(schema.purchases.merchantId, mergedMerchantId));
    await this.db.update(schema.merchants).set({ mergedIntoMerchantId: survivingMerchantId }).where(eq(schema.merchants.id, mergedMerchantId));

    const lineageId = generateId("merchantMergeLineage");
    await this.db.insert(schema.merchantMergeLineage).values({
      id: lineageId,
      survivingMerchantId,
      mergedMerchantId,
      mergedMerchantSnapshot: merged,
      repointedPurchaseIds,
      actorAdminId,
    });
    await this.recordAccess(actorAdminId, "admin.merchant_merge", "merchant", mergedMerchantId);

    return { lineageId, repointedPurchaseCount: repointedPurchaseIds.length };
  }

  /** Reverses exactly one merge: restores the merged merchant row and repoints only the purchases that merge actually moved. */
  async unmergeMerchants(lineageId: string, actorAdminId: string) {
    const [lineage] = await this.db
      .select()
      .from(schema.merchantMergeLineage)
      .where(eq(schema.merchantMergeLineage.id, lineageId))
      .limit(1);
    if (!lineage) throw new NotFoundException({ code: "MERGE_NOT_FOUND", message: "That merge record was not found." });
    if (lineage.unmergedAt) {
      throw new BadRequestException({ code: "ALREADY_UNMERGED", message: "That merge was already undone." });
    }

    await this.db
      .update(schema.merchants)
      .set({ mergedIntoMerchantId: null })
      .where(eq(schema.merchants.id, lineage.mergedMerchantId));

    for (const purchaseId of lineage.repointedPurchaseIds) {
      await this.db.update(schema.purchases).set({ merchantId: lineage.mergedMerchantId }).where(eq(schema.purchases.id, purchaseId));
    }

    await this.db
      .update(schema.merchantMergeLineage)
      .set({ unmergedAt: new Date() })
      .where(eq(schema.merchantMergeLineage.id, lineageId));
    await this.recordAccess(actorAdminId, "admin.merchant_unmerge", "merchant", lineage.mergedMerchantId);

    return { restoredPurchaseCount: lineage.repointedPurchaseIds.length };
  }

  private async recordAccess(actingAdminId: string, action: string, resourceType: string, resourceId: string): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "support_agent",
      actorId: actingAdminId,
      action,
      resourceType,
      resourceId,
      result: "success",
    });
  }
}
