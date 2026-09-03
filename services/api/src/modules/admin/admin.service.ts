import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes } from "node:crypto";
import * as argon2 from "argon2";
import { and, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import { generateId } from "@veynlo/core";
// Server-only Node util — see packages/core/src/index.ts's own doc comment for why this comes from its
// own subpath rather than the main barrel.
import { hashOpaqueToken } from "@veynlo/core/dist/util/token";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { IdentityService } from "../identity/identity.service";
import type { CreateAdminDto, CreateSignupInviteDto, GrantEntitlementDto, SuspendUserDto } from "./dto";

// Excludes visually-ambiguous characters (0/O, 1/I/L) — these codes are meant to be read off a screen and
// typed by hand during private testing, unlike shareLinks' URL-embedded tokens which are only ever
// copy-pasted. 12 chars from this 32-symbol alphabet is 60 bits of entropy, comfortably enough for a
// single-use, admin-issued, revocable code at the volume this feature will ever see. Hashed at rest via
// the same sha256(raw)-hex scheme as shareLinks.tokenHash — @veynlo/core's hashOpaqueToken is reused here
// (shared with identity.service.ts's redemption check) even though invite codes use a different
// alphabet/length than that helper's own token-generation half; the hash function itself is
// format-agnostic.
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const INVITE_CODE_LENGTH = 12;

function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) code += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
  return code;
}

/** The only sources an admin action is allowed to touch — a real payment processor's entitlement (Stripe/
 * App Store/Play Store) must only ever change via that processor's own webhook, never a manual admin edit
 * silently diverging from what the processor actually believes happened. */
const ADMIN_MANAGEABLE_ENTITLEMENT_SOURCES = ["support_granted", "promotional", "grandfathered", "referral", "partner_sponsored"];

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
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  async findUserByEmail(rawEmail: string, actingAdminId: string) {
    const email = rawEmail.trim().toLowerCase();
    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.email, email)).limit(1);
    // Every support lookup is audited regardless of hit/miss — a support agent probing for an email
    // that doesn't exist is still access-worth-recording (§45 "least privilege... audited access").
    await this.recordAccess(actingAdminId, "admin.user_lookup", "user", user?.id ?? email);
    if (!user) return null;

    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, user.id));
    const entitlements = await this.db.select().from(schema.entitlements).where(eq(schema.entitlements.userId, user.id));
    const [recentFailures, exportJobs, automation] = await Promise.all([
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
      this.automationSummaryForUser(user.id),
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
      automationRules: automation.rules,
      recentAutomationRuns: automation.recentRuns,
    };
  }

  /**
   * Phase 2 §52.2 "automation/rule center" — found while auditing this session's own work: a support
   * agent debugging an automation complaint had no way to see a user's rules or recent run failures
   * without a raw DB query. Same metadata-only redaction stance as the rest of this method: rule names
   * and risk/approval settings are shown, but `commandsJson`/`resultJson` (an action's actual notification
   * text or task title) are not — that's user content, the same class of thing this method already never
   * exposes for messages/documents.
   */
  private async automationSummaryForUser(userId: string, limit = 10) {
    const rules = await this.db
      .select({
        id: schema.automationRules.id,
        name: schema.automationRules.name,
        riskTier: schema.automationRules.riskTier,
        approvalMode: schema.automationRules.approvalMode,
        enabled: schema.automationRules.enabled,
        createdAt: schema.automationRules.createdAt,
      })
      .from(schema.automationRules)
      .where(eq(schema.automationRules.ownerUserId, userId));

    const ruleIds = rules.map((r) => r.id);
    const recentRuns =
      ruleIds.length > 0
        ? await this.db
            .select({ id: schema.automationRuns.id, ruleId: schema.automationRuns.ruleId, state: schema.automationRuns.state, createdAt: schema.automationRuns.createdAt })
            .from(schema.automationRuns)
            .where(inArray(schema.automationRuns.ruleId, ruleIds))
            .orderBy(desc(schema.automationRuns.createdAt))
            .limit(limit)
        : [];

    return { rules, recentRuns };
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
   * `users.status`'s "suspended" value (packages/db/src/schema/identity.ts) has existed since the enum was
   * defined but nothing ever set it — AuthGuard rejected `deletion_pending`/`deleted` but had no code path
   * that could ever produce "suspended" in the first place. This is that write path: a real, reversible,
   * admin-only action (fraud/abuse/ToS violation, not the user's own deletion request) for taking an
   * account offline without touching its data — everything about the account (connections, purchases,
   * automation rules) stays intact, and unsuspendUser below restores exactly `active`.
   *
   * Sessions are revoked synchronously in the same way requestDeletion() already does, so a suspension
   * takes effect immediately rather than waiting for the access token to expire (AuthGuard's own status
   * check is the belt-and-suspenders backstop for a request already in flight, not the primary
   * enforcement).
   */
  async suspendUser(userId: string, dto: SuspendUserDto, actorAdminId: string) {
    const [user] = await this.db.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });
    if (user.status === "deletion_pending" || user.status === "deleted") {
      throw new BadRequestException({ code: "ACCOUNT_ALREADY_DEPARTING", message: "This account is already deleted or pending deletion — suspension doesn't apply." });
    }
    if (user.status === "suspended") {
      throw new BadRequestException({ code: "ALREADY_SUSPENDED", message: "This account is already suspended." });
    }
    await this.db.update(schema.users).set({ status: "suspended", updatedAt: new Date() }).where(eq(schema.users.id, userId));
    await this.identity.revokeAllSessions(userId);
    await this.recordAccess(actorAdminId, "admin.user_suspend", "user", userId, { reason: dto.reason });
  }

  /** Restores a suspended account to `active`. Deliberately narrow — only reverses a suspension this same
   * action tier applies; an account that's `deletion_pending`/`deleted` needs the account-recovery flow
   * (out of scope here), not this endpoint. */
  async unsuspendUser(userId: string, actorAdminId: string) {
    const [user] = await this.db.select({ id: schema.users.id, status: schema.users.status }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });
    if (user.status !== "suspended") {
      throw new BadRequestException({ code: "NOT_SUSPENDED", message: "This account isn't suspended." });
    }
    await this.db.update(schema.users).set({ status: "active", updatedAt: new Date() }).where(eq(schema.users.id, userId));
    await this.recordAccess(actorAdminId, "admin.user_unsuspend", "user", userId);
  }

  /**
   * Admin-facing force-logout for a consumer user — same underlying revocation as
   * IdentityService.revokeAllSessions (used by delete-account and the security page's own "sign out
   * everywhere"), just reachable by support without requiring the account to be suspended or deleted
   * first. Useful on its own for "user reports their account/device was compromised" support flows where
   * suspension would be the wrong (too strong, not reversible-by-the-user) response — the account stays
   * fully usable, it just has to sign back in everywhere.
   */
  async forceLogoutUser(userId: string, actorAdminId: string) {
    const [user] = await this.db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    if (!user) throw new NotFoundException({ code: "USER_NOT_FOUND", message: "User not found." });
    await this.identity.revokeAllSessions(userId);
    await this.recordAccess(actorAdminId, "admin.user_force_logout", "user", userId);
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

  /**
   * §AI-003 "prompt-injection and untrusted-source defense" analytics — `prompt_security_events`
   * (AnthropicExtractionService's post-hoc heuristic detector) previously had no read side at all, so there
   * was no way to know whether an injection attempt ever actually occurred, let alone how often the
   * schema-constrained defense held. `windowDays` mirrors `modelHealthSummary`'s own default window.
   */
  async promptSecuritySummary(windowDays = 7) {
    const since = new Date(Date.now() - windowDays * 86_400_000);
    const rows = await this.db.select().from(schema.promptSecurityEvents).where(gte(schema.promptSecurityEvents.createdAt, since)).orderBy(desc(schema.promptSecurityEvents.createdAt));
    return {
      windowDays,
      totalDetections: rows.length,
      recent: rows.slice(0, 20).map((r) => ({ id: r.id, sourceEventId: r.sourceEventId, kind: r.kind, detail: r.detail, createdAt: r.createdAt })),
    };
  }

  /**
   * §39.2 "Per-domain offline evaluation suites include precision/recall of fields, date/amount exactness
   * ..." — the read side of `model_eval_runs` (services/api/src/modules/intelligence/eval/
   * run-golden-set-eval.ts is the writer, an opt-in, manually/scheduler-run harness — never on every commit,
   * since it makes real billable Anthropic API calls). Before this existed, a prompt or model-routing change
   * that quietly degraded extraction quality had nothing to surface it — this is that visibility: the most
   * recent run's aggregate/per-schema pass rate plus a short history, so a real regression shows up as a
   * trend line an operator can actually see, not a silent surprise. Returns `latestRun: null` when the
   * harness has genuinely never been run yet, distinct from a run that scored 0% — those are different
   * facts and the admin UI needs to tell them apart.
   */
  async modelEvalSummary(historyLimit = 20) {
    const rows = await this.db.select().from(schema.modelEvalRuns).orderBy(desc(schema.modelEvalRuns.runAt)).limit(historyLimit);
    return {
      latestRun: rows[0] ?? null,
      history: rows.map((r) => ({
        id: r.id,
        modelKey: r.modelKey,
        goldenSetVersion: r.goldenSetVersion,
        totalCases: r.totalCases,
        passedCases: r.passedCases,
        passRate: r.passRate,
        bySchema: r.bySchema,
        triggeredBy: r.triggeredBy,
        runAt: r.runAt,
      })),
    };
  }

  /**
   * §47.4 "Track cost per active user, paid user, ... Ask query, automation run and historical backfill" /
   * §39.2 "tokens/cost" telemetry — the admin-facing read side of `extraction_runs.costMinorUnits`
   * (AnthropicExtractionService.finishRun writes it; EntitlementsService.currentPeriodAiCostMinorUnits sums
   * it per user for the backfill cost-pressure pause). This is the aggregate view: total spend and a
   * day-by-day trend over the window, plus the highest-spending users so an operator can spot a runaway
   * account without a raw SQL query. `windowDays` mirrors `modelHealthSummary`'s own pattern; defaults wider
   * (30, not 7) since cost trends matter more over a longer horizon than raw pass/fail rates do.
   */
  async aiCostSummary(windowDays = 30) {
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const [totals] = await this.db
      .select({
        totalCostMinorUnits: sql<string>`coalesce(sum(${schema.extractionRuns.costMinorUnits}), 0)`,
        totalRuns: sql<string>`count(*)`,
      })
      .from(schema.extractionRuns)
      .where(gte(schema.extractionRuns.startedAt, since));

    const dayExpr = sql<string>`date_trunc('day', ${schema.extractionRuns.startedAt})`;
    const byDayRows = await this.db
      .select({ day: dayExpr.as("day"), costMinorUnits: sql<string>`coalesce(sum(${schema.extractionRuns.costMinorUnits}), 0)` })
      .from(schema.extractionRuns)
      .where(gte(schema.extractionRuns.startedAt, since))
      .groupBy(dayExpr)
      .orderBy(dayExpr);

    const byUserRows = await this.db
      .select({
        userId: schema.sourceEvents.ownerUserId,
        email: schema.users.email,
        costMinorUnits: sql<string>`coalesce(sum(${schema.extractionRuns.costMinorUnits}), 0)`,
        runs: sql<string>`count(*)`,
      })
      .from(schema.extractionRuns)
      .innerJoin(schema.sourceEvents, eq(schema.sourceEvents.id, schema.extractionRuns.sourceEventId))
      .innerJoin(schema.users, eq(schema.users.id, schema.sourceEvents.ownerUserId))
      .where(gte(schema.extractionRuns.startedAt, since))
      .groupBy(schema.sourceEvents.ownerUserId, schema.users.email)
      .orderBy(desc(sql`sum(${schema.extractionRuns.costMinorUnits})`))
      .limit(25);

    return {
      windowDays,
      totalCostMinorUnits: Number(totals?.totalCostMinorUnits ?? 0),
      totalRuns: Number(totals?.totalRuns ?? 0),
      byDay: byDayRows.map((r) => ({ day: r.day, costMinorUnits: Number(r.costMinorUnits) })),
      byUser: byUserRows.map((r) => ({ userId: r.userId, email: r.email, costMinorUnits: Number(r.costMinorUnits), runs: Number(r.runs) })),
    };
  }

  /**
   * §48 "Product Analytics, Experimentation & Growth" — the admin-facing summary view over
   * `product_events` (AnalyticsService.track's single write path). Same shape/windowing convention as
   * `aiCostSummary` just above (totals + a by-day breakdown for a trend line), plus a by-event-name
   * breakdown so an operator can see which parts of the funnel (`signup_completed`, `item_caught`,
   * `search_submitted`, etc.) are actually firing. Admin/self-visible only (AdminGuard on the controller
   * route) — never exposed to other users, matching §48.2's "pseudonymous warehouse keys" posture: this
   * view aggregates across all users rather than ever surfacing one user's individual event trail to
   * anyone but an authenticated admin operator.
   */
  async analyticsSummary(windowDays = 30) {
    const since = new Date(Date.now() - windowDays * 86_400_000);

    const [totals] = await this.db
      .select({
        totalEvents: sql<string>`count(*)`,
        distinctUsers: sql<string>`count(distinct ${schema.productEvents.userId})`,
      })
      .from(schema.productEvents)
      .where(gte(schema.productEvents.occurredAt, since));

    const dayExpr = sql<string>`date_trunc('day', ${schema.productEvents.occurredAt})`;
    const byDayRows = await this.db
      .select({ day: dayExpr.as("day"), count: sql<string>`count(*)` })
      .from(schema.productEvents)
      .where(gte(schema.productEvents.occurredAt, since))
      .groupBy(dayExpr)
      .orderBy(dayExpr);

    const byEventRows = await this.db
      .select({ eventName: schema.productEvents.eventName, count: sql<string>`count(*)` })
      .from(schema.productEvents)
      .where(gte(schema.productEvents.occurredAt, since))
      .groupBy(schema.productEvents.eventName)
      .orderBy(desc(sql`count(*)`));

    return {
      windowDays,
      totalEvents: Number(totals?.totalEvents ?? 0),
      distinctUsers: Number(totals?.distinctUsers ?? 0),
      byDay: byDayRows.map((r) => ({ day: r.day, count: Number(r.count) })),
      byEvent: byEventRows.map((r) => ({ eventName: r.eventName, count: Number(r.count) })),
    };
  }

  async connectorHealthSummary() {
    const connections = await this.db.select().from(schema.connections).where(ne(schema.connections.health, "disconnected"));
    const byHealth: Record<string, number> = {};
    for (const c of connections) byHealth[c.health] = (byHealth[c.health] ?? 0) + 1;
    return { total: connections.length, byHealth };
  }

  /** §Operations "connector/job/model health" — job depth/failure counts, previously invisible to admin. */
  async queueHealthSummary() {
    return this.queue.getQueueHealth();
  }

  /**
   * §Operations "privacy workflows" — previously only reachable one user at a time via findUserByEmail;
   * there was no admin-wide view of every pending export/deletion request, found live via a real audit.
   * A "stuck" export (queued/processing well past when the worker should have picked it up) or a deletion
   * that never finished draining is exactly what a support agent needs to see across ALL users, not just
   * whichever one they happen to already be looking up by email.
   */
  async privacyRequestsWorklist() {
    const pendingExports = await this.db
      .select({
        id: schema.exportJobs.id,
        userId: schema.exportJobs.ownerUserId,
        email: schema.users.email,
        state: schema.exportJobs.state,
        requestedAt: schema.exportJobs.requestedAt,
      })
      .from(schema.exportJobs)
      .innerJoin(schema.users, eq(schema.users.id, schema.exportJobs.ownerUserId))
      .where(inArray(schema.exportJobs.state, ["queued", "processing"]))
      .orderBy(schema.exportJobs.requestedAt);

    const pendingDeletions = await this.db
      .select({ id: schema.users.id, email: schema.users.email, deletedAt: schema.users.deletedAt, updatedAt: schema.users.updatedAt })
      .from(schema.users)
      .where(eq(schema.users.status, "deletion_pending"))
      .orderBy(schema.users.updatedAt);

    return { pendingExports, pendingDeletions };
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
   *
   * Also repoints storeCredits.merchantId and recurringStreams.merchantId — found missing while auditing
   * this method: both tables carry the same merchantId FK purchases does, so a merge that only moved
   * purchases left a merged-away merchant's store credits/recurring streams pointed at a merchant row that
   * still exists (not an FK violation) but is excluded from every admin/user-facing merchant list, making
   * that lineage effectively invisible. All three repoints (plus the merchants/lineage writes) run in one
   * transaction — a merge is one atomic fact, not three independent ones that could partially apply if a
   * later step failed.
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

    const lineageId = generateId("merchantMergeLineage");
    const { repointedPurchaseIds, repointedStoreCreditIds, repointedRecurringStreamIds } = await this.db.transaction(async (tx) => {
      const [repointedPurchases, repointedStoreCredits, repointedRecurringStreams] = await Promise.all([
        tx.select({ id: schema.purchases.id }).from(schema.purchases).where(eq(schema.purchases.merchantId, mergedMerchantId)),
        tx.select({ id: schema.storeCredits.id }).from(schema.storeCredits).where(eq(schema.storeCredits.merchantId, mergedMerchantId)),
        tx.select({ id: schema.recurringStreams.id }).from(schema.recurringStreams).where(eq(schema.recurringStreams.merchantId, mergedMerchantId)),
      ]);
      const repointedPurchaseIds = repointedPurchases.map((p) => p.id);
      const repointedStoreCreditIds = repointedStoreCredits.map((s) => s.id);
      const repointedRecurringStreamIds = repointedRecurringStreams.map((r) => r.id);

      await tx.update(schema.purchases).set({ merchantId: survivingMerchantId }).where(eq(schema.purchases.merchantId, mergedMerchantId));
      await tx.update(schema.storeCredits).set({ merchantId: survivingMerchantId }).where(eq(schema.storeCredits.merchantId, mergedMerchantId));
      await tx.update(schema.recurringStreams).set({ merchantId: survivingMerchantId }).where(eq(schema.recurringStreams.merchantId, mergedMerchantId));
      await tx.update(schema.merchants).set({ mergedIntoMerchantId: survivingMerchantId }).where(eq(schema.merchants.id, mergedMerchantId));

      await tx.insert(schema.merchantMergeLineage).values({
        id: lineageId,
        survivingMerchantId,
        mergedMerchantId,
        mergedMerchantSnapshot: merged,
        repointedPurchaseIds,
        repointedStoreCreditIds,
        repointedRecurringStreamIds,
        actorAdminId,
      });

      return { repointedPurchaseIds, repointedStoreCreditIds, repointedRecurringStreamIds };
    });
    await this.recordAccess(actorAdminId, "admin.merchant_merge", "merchant", mergedMerchantId);

    return {
      lineageId,
      repointedPurchaseCount: repointedPurchaseIds.length,
      repointedStoreCreditCount: repointedStoreCreditIds.length,
      repointedRecurringStreamCount: repointedRecurringStreamIds.length,
    };
  }

  /** Reverses exactly one merge: restores the merged merchant row and repoints only the purchases/store
   * credits/recurring streams that merge actually moved (mirrors mergeMerchants' three-table repoint
   * above), all in one transaction. */
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

    await this.db.transaction(async (tx) => {
      await tx.update(schema.merchants).set({ mergedIntoMerchantId: null }).where(eq(schema.merchants.id, lineage.mergedMerchantId));

      for (const purchaseId of lineage.repointedPurchaseIds) {
        await tx.update(schema.purchases).set({ merchantId: lineage.mergedMerchantId }).where(eq(schema.purchases.id, purchaseId));
      }
      for (const storeCreditId of lineage.repointedStoreCreditIds) {
        await tx.update(schema.storeCredits).set({ merchantId: lineage.mergedMerchantId }).where(eq(schema.storeCredits.id, storeCreditId));
      }
      for (const recurringStreamId of lineage.repointedRecurringStreamIds) {
        await tx.update(schema.recurringStreams).set({ merchantId: lineage.mergedMerchantId }).where(eq(schema.recurringStreams.id, recurringStreamId));
      }

      await tx.update(schema.merchantMergeLineage).set({ unmergedAt: new Date() }).where(eq(schema.merchantMergeLineage.id, lineageId));
    });
    await this.recordAccess(actorAdminId, "admin.merchant_unmerge", "merchant", lineage.mergedMerchantId);

    return {
      restoredPurchaseCount: lineage.repointedPurchaseIds.length,
      restoredStoreCreditCount: lineage.repointedStoreCreditIds.length,
      restoredRecurringStreamCount: lineage.repointedRecurringStreamIds.length,
    };
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

  /**
   * "Pre-launch private testing distribution" (docs/ROADMAP.md) — creates an invite code, returning the
   * PLAINTEXT code exactly once (same shown-once posture as createAdmin's temporaryPassword above). Only
   * the sha256 hash is ever persisted, matching shareLinks.tokenHash's design.
   */
  async createSignupInvite(dto: CreateSignupInviteDto, actorAdminId: string) {
    const code = generateInviteCode();
    const id = generateId("signupInvite");
    const expiresAt = dto.expiresInDays ? new Date(Date.now() + dto.expiresInDays * 86_400_000) : null;
    await this.db.insert(schema.signupInvites).values({
      id,
      codeHash: hashOpaqueToken(code),
      email: dto.email ?? null,
      createdByAdminId: actorAdminId,
      expiresAt,
    });
    await this.recordAccess(actorAdminId, "admin.signup_invite_create", "signup_invite", id);
    return { id, code, email: dto.email ?? null, expiresAt };
  }

  /** codeHash is deliberately never selected — same "never return the hash either" hygiene as shareLinks'
   * list view (tokenHash/passcodeHash), even though a one-way hash isn't itself a usable credential. */
  async listSignupInvites() {
    return this.db
      .select({
        id: schema.signupInvites.id,
        email: schema.signupInvites.email,
        redeemedAt: schema.signupInvites.redeemedAt,
        redeemedByUserId: schema.signupInvites.redeemedByUserId,
        createdByAdminId: schema.signupInvites.createdByAdminId,
        createdAt: schema.signupInvites.createdAt,
        expiresAt: schema.signupInvites.expiresAt,
        revokedAt: schema.signupInvites.revokedAt,
      })
      .from(schema.signupInvites)
      .orderBy(desc(schema.signupInvites.createdAt));
  }

  async revokeSignupInvite(inviteId: string, actorAdminId: string) {
    const [invite] = await this.db.select().from(schema.signupInvites).where(eq(schema.signupInvites.id, inviteId)).limit(1);
    if (!invite) throw new NotFoundException({ code: "INVITE_NOT_FOUND", message: "Invite not found." });
    if (invite.revokedAt) {
      throw new BadRequestException({ code: "ALREADY_REVOKED", message: "This invite was already revoked." });
    }
    if (invite.redeemedAt) {
      throw new BadRequestException({ code: "ALREADY_REDEEMED", message: "This invite was already redeemed and can't be revoked." });
    }
    await this.db.update(schema.signupInvites).set({ revokedAt: new Date() }).where(eq(schema.signupInvites.id, inviteId));
    await this.recordAccess(actorAdminId, "admin.signup_invite_revoke", "signup_invite", inviteId);
  }

  async recordAccess(actingAdminId: string, action: string, resourceType: string, resourceId: string, detail?: unknown): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "support_agent",
      actorId: actingAdminId,
      action,
      resourceType,
      resourceId,
      // `afterJson` re-purposed here as "the extra context for this action" (e.g. suspendUser's reason) —
      // there's no literal before/after state for an action like this, but it's the existing encrypted
      // free-text slot on this table rather than adding a parallel column just for suspension reasons.
      afterJson: detail ?? null,
      result: "success",
    });
  }
}
