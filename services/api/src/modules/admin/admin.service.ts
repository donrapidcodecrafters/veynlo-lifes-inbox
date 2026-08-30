import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { and, desc, eq, gte, isNull, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { SearchIndexService } from "../search/search-index.service";
import type { CreateAdminDto, GrantEntitlementDto } from "./dto";

/** The only sources an admin action is allowed to touch — a real payment processor's entitlement (Stripe/
 * App Store/Play Store) must only ever change via that processor's own webhook, never a manual admin edit
 * silently diverging from what the processor actually believes happened. */
const ADMIN_MANAGEABLE_ENTITLEMENT_SOURCES = ["support_granted", "promotional", "grandfathered", "referral", "partner_sponsored"];

/** Strips punctuation/casing/common corporate suffixes so "Amazon.com", "AMAZON MKTPLACE PMTS", and "Amazon, Inc." group together. */
export function normalizeMerchantName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.(com|net|org|co)\b/g, "")
    .replace(/\b(inc|llc|ltd|corp|co)\b\.?/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

@Injectable()
export class AdminService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly searchIndex: SearchIndexService,
  ) {}

  async findUserByEmail(email: string, actingAdminId: string) {
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    // Every support lookup is audited regardless of hit/miss — a support agent probing for an email
    // that doesn't exist is still access-worth-recording (§45 "least privilege... audited access").
    await this.recordAccess(actingAdminId, "admin.user_lookup", "user", user?.id ?? email);
    if (!user) return null;

    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, user.id));
    const entitlements = await this.db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, user.id));
    const [recentFailures, exportJobs] = await Promise.all([
      this.recentExtractionFailuresForUser(user.id),
      this.db
        .select({
          id: schema.exportJobs.id,
          state: schema.exportJobs.state,
          errorMessage: schema.exportJobs.errorMessage,
          requestedAt: schema.exportJobs.requestedAt,
          completedAt: schema.exportJobs.completedAt,
          expiresAt: schema.exportJobs.expiresAt,
        })
        .from(schema.exportJobs)
        .where(eq(schema.exportJobs.ownerUserId, user.id))
        .orderBy(desc(schema.exportJobs.requestedAt))
        .limit(10),
    ]);
    // Support tooling intentionally exposes only metadata (status, plan, connector health) — never message/document
    // bodies or financial details (§ "ADMIN SUPPORT ACCESS": "prefer metadata... redacted views").
    return {
      id: user.id,
      email: user.email,
      status: user.status,
      deletedAt: user.deletedAt,
      createdAt: user.createdAt,
      connections: connections.map((c) => ({
        id: c.id,
        provider: c.provider,
        health: c.health,
        healthDetail: c.healthDetail,
        lastSuccessfulSyncAt: c.lastSuccessfulSyncAt,
      })),
      entitlements,
      recentExtractionFailures: recentFailures,
      exportJobs,
    };
  }

  /**
   * §Operations "per-user diagnostics" — `modelHealthSummary` below is aggregate-only, so a support agent
   * looking at one user's account had no way to see whether ingestion was actually failing for them
   * specifically. `extraction_runs` has no direct `userId` column (it's keyed by `sourceEventId`), so
   * ownership is resolved via `source_events.ownerUserId` the same way evidence resolution already does
   * elsewhere in the app.
   */
  private async recentExtractionFailuresForUser(userId: string, limit = 10) {
    return this.db
      .select({
        id: schema.extractionRuns.id,
        extractorName: schema.extractorVersions.name,
        modelKey: schema.extractorVersions.modelKey,
        errorDetail: schema.extractionRuns.errorDetail,
        startedAt: schema.extractionRuns.startedAt,
        completedAt: schema.extractionRuns.completedAt,
      })
      .from(schema.extractionRuns)
      .innerJoin(schema.extractorVersions, eq(schema.extractorVersions.id, schema.extractionRuns.extractorVersionId))
      .innerJoin(schema.sourceEvents, eq(schema.sourceEvents.id, schema.extractionRuns.sourceEventId))
      .where(and(eq(schema.sourceEvents.ownerUserId, userId), eq(schema.extractionRuns.status, "failed")))
      .orderBy(desc(schema.extractionRuns.startedAt))
      .limit(limit);
  }

  /**
   * §46.2/support-tooling — the `entitlements.source` enum has included `"support_granted"`,
   * `"promotional"`, `"grandfathered"`, etc. since the entitlements system shipped, but nothing anywhere
   * ever wrote one: a support agent had no way to comp a user a plan (refund goodwill, a bug they hit, a
   * partner deal) without a raw DB edit. This is that missing write path.
   */
  async grantEntitlement(userId: string, dto: GrantEntitlementDto, actorAdminId: string) {
    const [user] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });

    const id = generateId("entitlement");
    const effectiveFrom = new Date();
    const effectiveTo = dto.durationDays ? new Date(effectiveFrom.getTime() + dto.durationDays * 86_400_000) : null;
    await this.db.insert(schema.entitlements).values({
      id,
      userId,
      planKey: dto.planKey,
      source: "support_granted",
      effectiveFrom,
      effectiveTo,
      reason: dto.reason,
    });
    await this.recordAccess(actorAdminId, "admin.entitlement_grant", "entitlement", id);
    return { id, planKey: dto.planKey, effectiveFrom, effectiveTo };
  }

  /** Only reverses an admin-manageable entitlement (see ADMIN_MANAGEABLE_ENTITLEMENT_SOURCES) — a real
   * Stripe/App Store/Play Store entitlement must only ever change via that processor's own webhook. */
  async revokeEntitlement(entitlementId: string, actorAdminId: string) {
    const [entitlement] = await this.db.select().from(schema.entitlements).where(eq(schema.entitlements.id, entitlementId)).limit(1);
    if (!entitlement) throw new NotFoundException({ code: "ENTITLEMENT_NOT_FOUND", message: "Entitlement not found." });
    if (!ADMIN_MANAGEABLE_ENTITLEMENT_SOURCES.includes(entitlement.source)) {
      throw new BadRequestException({
        code: "NOT_ADMIN_REVOCABLE",
        message: "This entitlement came from a real payment processor and can't be changed here — it follows that processor's own billing state.",
      });
    }
    if (entitlement.effectiveTo && entitlement.effectiveTo <= new Date()) {
      throw new BadRequestException({ code: "ALREADY_EXPIRED", message: "This entitlement has already ended." });
    }
    await this.db.update(schema.entitlements).set({ effectiveTo: new Date() }).where(eq(schema.entitlements.id, entitlementId));
    await this.recordAccess(actorAdminId, "admin.entitlement_revoke", "entitlement", entitlementId);
  }

  /**
   * §Operations "job/model health monitoring" — `extraction_runs`/`extractor_versions` have existed in the
   * schema since the pipeline shipped, but nothing ever wrote to them (see `AnthropicExtractionService`,
   * which now instruments every ingestion-pipeline AI call). This is the read side: per-extractor success
   * rate/latency over a recent window, plus the most recent failures so a support agent or engineer can
   * see whether "the AI pipeline" is healthy without grepping process logs.
   */
  async modelHealthSummary(windowDays = 7) {
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await this.db
      .select({
        extractorName: schema.extractorVersions.name,
        modelKey: schema.extractorVersions.modelKey,
        status: schema.extractionRuns.status,
        latencyMs: schema.extractionRuns.latencyMs,
        errorDetail: schema.extractionRuns.errorDetail,
        startedAt: schema.extractionRuns.startedAt,
      })
      .from(schema.extractionRuns)
      .innerJoin(schema.extractorVersions, eq(schema.extractorVersions.id, schema.extractionRuns.extractorVersionId))
      .where(gte(schema.extractionRuns.startedAt, since))
      .orderBy(desc(schema.extractionRuns.startedAt));

    interface Bucket {
      total: number;
      success: number;
      failed: number;
      running: number;
      totalLatencyMs: number;
      latencyCount: number;
    }
    const byExtractor = new Map<string, Bucket>();
    for (const row of rows) {
      const bucket = byExtractor.get(row.extractorName) ?? { total: 0, success: 0, failed: 0, running: 0, totalLatencyMs: 0, latencyCount: 0 };
      bucket.total += 1;
      if (row.status === "success") bucket.success += 1;
      else if (row.status === "failed") bucket.failed += 1;
      else bucket.running += 1;
      if (row.latencyMs != null) {
        bucket.totalLatencyMs += row.latencyMs;
        bucket.latencyCount += 1;
      }
      byExtractor.set(row.extractorName, bucket);
    }

    return {
      windowDays,
      totalRuns: rows.length,
      byExtractor: [...byExtractor.entries()].map(([extractorName, b]) => ({
        extractorName,
        total: b.total,
        success: b.success,
        failed: b.failed,
        running: b.running,
        successRate: b.total > 0 ? b.success / b.total : null,
        avgLatencyMs: b.latencyCount > 0 ? Math.round(b.totalLatencyMs / b.latencyCount) : null,
      })),
      recentFailures: rows
        .filter((r) => r.status === "failed")
        .slice(0, 20)
        .map((r) => ({ extractorName: r.extractorName, modelKey: r.modelKey, errorDetail: r.errorDetail, startedAt: r.startedAt })),
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
    await this.searchIndex.renameIndexedTitles("purchase", repointedPurchaseIds, surviving.displayName);

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
    const mergedSnapshot = lineage.mergedMerchantSnapshot as { displayName: string };
    await this.searchIndex.renameIndexedTitles("purchase", lineage.repointedPurchaseIds, mergedSnapshot.displayName);

    await this.db
      .update(schema.merchantMergeLineage)
      .set({ unmergedAt: new Date() })
      .where(eq(schema.merchantMergeLineage.id, lineageId));
    await this.recordAccess(actorAdminId, "admin.merchant_unmerge", "merchant", lineage.mergedMerchantId);

    return { restoredPurchaseCount: lineage.repointedPurchaseIds.length };
  }

  /**
   * Self-service replacement for the create-admin.ts CLI script's ongoing use case — that script stays,
   * since it solves a different problem (bootstrapping the *first* admin, before any admin session exists
   * to authenticate this endpoint with). Same one-time-visible-temporary-password pattern as the script.
   * Guarded to superadmin-only at the controller (SuperAdminGuard) — one operator account creating another
   * is exactly the kind of action the schema's role split was meant for.
   */
  async listAdmins() {
    return this.db
      .select({
        id: schema.adminUsers.id,
        email: schema.adminUsers.email,
        displayName: schema.adminUsers.displayName,
        role: schema.adminUsers.role,
        createdAt: schema.adminUsers.createdAt,
        lastLoginAt: schema.adminUsers.lastLoginAt,
        revokedAt: schema.adminUsers.revokedAt,
      })
      .from(schema.adminUsers)
      .orderBy(desc(schema.adminUsers.createdAt));
  }

  async createAdmin(dto: CreateAdminDto, actorAdminId: string) {
    const [existing] = await this.db.select().from(schema.adminUsers).where(eq(schema.adminUsers.email, dto.email)).limit(1);
    if (existing) {
      throw new ConflictException({ code: "ADMIN_ALREADY_EXISTS", message: "An admin account already exists for this email." });
    }
    const temporaryPassword = randomBytes(12).toString("base64url");
    const passwordHash = await argon2.hash(temporaryPassword);
    const id = generateId("adminUser");
    await this.db.insert(schema.adminUsers).values({
      id,
      email: dto.email,
      displayName: dto.displayName,
      passwordHash,
      role: dto.role,
    });
    await this.recordAccess(actorAdminId, "admin.admin_create", "admin_user", id);
    // Shown once — same as create-admin.ts's CLI output; there is no "forgot password" flow for admin
    // accounts by design (§45 no self-serve admin sign-up), so this is the only time it's ever visible.
    return { id, temporaryPassword };
  }

  async revokeAdmin(targetAdminId: string, actorAdminId: string) {
    if (targetAdminId === actorAdminId) {
      throw new BadRequestException({ code: "CANNOT_REVOKE_SELF", message: "You can't revoke your own admin account." });
    }
    const [target] = await this.db.select().from(schema.adminUsers).where(eq(schema.adminUsers.id, targetAdminId)).limit(1);
    if (!target) throw new NotFoundException({ code: "ADMIN_NOT_FOUND", message: "Admin account not found." });
    await this.db.update(schema.adminUsers).set({ revokedAt: new Date() }).where(eq(schema.adminUsers.id, targetAdminId));
    // Revoking access must take effect immediately, not at next token expiry — same principle as AdminGuard
    // re-checking the session row on every request; without this, a revoked admin's live session/JWT would
    // keep working until it naturally expired.
    await this.db
      .update(schema.adminSessions)
      .set({ revokedAt: new Date() })
      .where(eq(schema.adminSessions.adminUserId, targetAdminId));
    await this.recordAccess(actorAdminId, "admin.admin_revoke", "admin_user", targetAdminId);
  }

  async recordAccess(actingAdminId: string, action: string, resourceType: string, resourceId: string): Promise<void> {
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
