import { ForbiddenException, Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { resolveCapability, type CapabilityKey, type CapabilityValue, type PlanKey } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CACHE, type Cache } from "../../cache/cache.interface";

/** Start of the current UTC calendar month — the "current billing month" §47.4's "cost per active user"
 * tracks against. UTC (not the caller's local time) so the boundary is the same instant for every user
 * regardless of timezone, matching every other server-side day/period boundary in this codebase (e.g.
 * assertAskQuota's `toISOString().slice(0, 10)` day key just below). */
function startOfCurrentBillingMonthUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

const EMAIL_PROVIDERS = new Set(["gmail", "outlook"]);
const CALENDAR_PROVIDERS = new Set(["google_calendar", "microsoft_calendar", "ics", "google_tasks", "microsoft_todo"]);
const STORAGE_PROVIDERS = new Set(["google_drive", "onedrive", "dropbox"]);
const FINANCIAL_PROVIDERS = new Set(["plaid"]);

const CONNECTOR_QUOTA_CAPABILITY: Record<"email" | "calendar" | "storage" | "financial", CapabilityKey> = {
  email: "email_connections_max",
  calendar: "calendar_connections_max",
  storage: "cloud_storage_connections_max",
  financial: "financial_aggregator_connections_max",
};

const CONNECTOR_QUOTA_PROVIDERS: Record<"email" | "calendar" | "storage" | "financial", Set<string>> = {
  email: EMAIL_PROVIDERS,
  calendar: CALENDAR_PROVIDERS,
  storage: STORAGE_PROVIDERS,
  financial: FINANCIAL_PROVIDERS,
};

/**
 * §46 — the actual enforcement layer for `packages/core`'s `CapabilityKey`s. `resolveCapability` has
 * existed since the entitlements system shipped and `BillingService.currentEntitlements` has always
 * called it to *report* a user's capabilities, but nothing outside billing ever called it to *enforce*
 * one (see docs/ROADMAP.md's billing/entitlements row: "no connector-count check, no Ask throttle, no
 * storage cap beyond a flat 25MB-per-file limit, no household-size check"). This service is the single
 * place those four checks live so a plan limit is never reimplemented differently per call site.
 */
@Injectable()
export class EntitlementsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CACHE) private readonly cache: Cache,
  ) {}

  async getCapability(userId: string, key: CapabilityKey): Promise<CapabilityValue> {
    const now = new Date();
    const active = await this.db
      .select({
        planKey: schema.entitlements.planKey,
        effectiveFrom: schema.entitlements.effectiveFrom,
        effectiveTo: schema.entitlements.effectiveTo,
      })
      .from(schema.entitlements)
      .where(
        and(
          eq(schema.entitlements.userId, userId),
          or(isNull(schema.entitlements.effectiveTo), gt(schema.entitlements.effectiveTo, now)),
        ),
      );
    const capabilityInput = active.map((e) => ({ ...e, planKey: e.planKey as PlanKey }));
    return resolveCapability(capabilityInput, key, now);
  }

  /**
   * §Monetization "plan gates initial connector backfill depth" — every connector adapter's initial sync
   * previously hardcoded `historyDepthDays: 90` for every plan, silently ignoring `PLAN_CATALOG`'s own
   * declared 30/365/unlimited split (found live via a real audit). `historical_backfill_days` is a bounded
   * integer column on `connections`, so "unlimited" (the `pro_agent` tier, not yet sold) resolves to a
   * large practical cap rather than a literal infinity.
   */
  /**
   * ONB-002 "Free limited; Plus+ expanded" — `requestedDays`, when given, is the depth the onboarding
   * historical-depth-control UI asked for (e.g. a Free user picking "1 year"); this clamps it down to the
   * plan's real cap rather than trusting the client, the same "server is the enforcement point, not just
   * the UI" posture as assertConnectorQuota/assertStorageQuota above. Omitting `requestedDays` keeps the
   * pre-existing behavior every connector adapter's `handleCallback` already relied on: default to the
   * plan's full allowance.
   */
  async resolveHistoricalBackfillDays(userId: string, requestedDays?: number): Promise<number> {
    const value = await this.getCapability(userId, "historical_backfill_days");
    const max = typeof value === "number" ? value : 3650; // null = unlimited; ~10 years is a sane finite stand-in
    if (requestedDays === undefined) return max;
    return Math.min(Math.max(requestedDays, 0), max);
  }

  /** Gates a new Gmail/Outlook ("email") or Google/Microsoft/ICS ("calendar") connection against the
   * plan's connection-count cap. Called at the `/authorize` (or ICS `/connect`) step, before an OAuth
   * round-trip even starts — failing there is a clean synchronous error the Connections page can show,
   * rather than letting the user complete an OAuth grant only to reject it in the callback. */
  async assertConnectorQuota(userId: string, category: "email" | "calendar" | "storage" | "financial"): Promise<void> {
    const key = CONNECTOR_QUOTA_CAPABILITY[category];
    const max = await this.getCapability(userId, key);
    if (max === null || typeof max !== "number") return; // unlimited (or a boolean/misconfigured key — fail open, not closed)

    const providers = CONNECTOR_QUOTA_PROVIDERS[category];
    const rows = await this.db
      .select({ provider: schema.connections.provider })
      .from(schema.connections)
      .where(and(eq(schema.connections.ownerUserId, userId), isNull(schema.connections.disconnectedAt)));
    const count = rows.filter((r) => providers.has(r.provider)).length;
    if (count >= max) {
      throw new ForbiddenException({
        code: "CONNECTOR_LIMIT_REACHED",
        message: `Your plan allows up to ${max} ${category} connection${max === 1 ? "" : "s"}. Disconnect one or upgrade to connect more.`,
      });
    }
  }

  /** Ask's daily throttle. Deliberately backed by Redis (Valkey-shaped ephemeral counter), not a Postgres
   * table — this is exactly the "distributed rate-limit counter" use case the architecture reserves the
   * cache tier for, not a durable record anything else ever needs to query. */
  async assertAskQuota(userId: string): Promise<void> {
    const max = await this.getCapability(userId, "ask_queries_per_day");
    if (max === null || typeof max !== "number") return;

    const dayKey = new Date().toISOString().slice(0, 10);
    const cacheKey = `ask-quota:${userId}:${dayKey}`;
    const count = await this.cache.incr(cacheKey);
    if (count === 1) {
      await this.cache.expire(cacheKey, 60 * 60 * 48); // outlives one UTC day so a slow clock skew never drops the cap early
    }
    if (count > max) {
      throw new ForbiddenException({
        code: "ASK_QUOTA_EXCEEDED",
        message: `You've used today's ${max} Ask questions. Try again tomorrow, or upgrade for a higher daily limit.`,
      });
    }
  }

  /** Total-storage cap, on top of (not instead of) `DocumentsService`'s existing flat 25MB-per-file
   * limit — the per-file limit bounds one abusive upload, this bounds the account's cumulative footprint. */
  async assertStorageQuota(userId: string, incomingBytes: number): Promise<void> {
    const maxMb = await this.getCapability(userId, "document_storage_mb");
    if (maxMb === null || typeof maxMb !== "number") return;

    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${schema.documentVersions.sizeBytes}), 0)` })
      .from(schema.documentVersions)
      .innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId))
      .where(eq(schema.documents.ownerUserId, userId));
    const currentBytes = Number(row?.total ?? 0);
    const maxBytes = maxMb * 1024 * 1024;
    if (currentBytes + incomingBytes > maxBytes) {
      throw new ForbiddenException({
        code: "STORAGE_QUOTA_EXCEEDED",
        message: `This upload would exceed your plan's ${maxMb}MB document storage limit. Delete old files or upgrade your plan.`,
      });
    }
  }

  /**
   * §47.4 "Track cost per active user" / §39.2 "Budget guardrails exist per user ... historical backfill" —
   * real AI cost (`extraction_runs.costMinorUnits`, see AnthropicExtractionService.finishRun) summed for one
   * user over the current billing-month period. `extraction_runs` has no direct `userId` column — it's keyed
   * by `sourceEventId` — so ownership is resolved via `source_events.ownerUserId`, the same join
   * AdminService.recentExtractionFailuresForUser already uses for the identical reason. Consumed both by
   * IngestionService's backfill-specific cost-pressure pause (§47.4 "historical imports ... can pause under
   * ... budget pressure") and by the admin cost-summary view — one real query, not two parallel
   * reimplementations of "sum this user's AI spend."
   */
  async currentPeriodAiCostMinorUnits(userId: string, periodStart: Date = startOfCurrentBillingMonthUtc()): Promise<number> {
    const [row] = await this.db
      .select({ total: sql<string>`coalesce(sum(${schema.extractionRuns.costMinorUnits}), 0)` })
      .from(schema.extractionRuns)
      .innerJoin(schema.sourceEvents, eq(schema.sourceEvents.id, schema.extractionRuns.sourceEventId))
      .where(and(eq(schema.sourceEvents.ownerUserId, userId), gte(schema.extractionRuns.startedAt, periodStart)));
    return Number(row?.total ?? 0);
  }

  /** Household size cap. Resolved against the household's billing owner, not the person doing the
   * inviting — a household's plan is whatever its `billingOwnerUserId` is subscribed to, and an adult
   * member can invite even though they don't personally hold the entitlement. Counts `active` and
   * `invited` memberships together so a pending invite already reserves a seat. */
  async assertHouseholdMemberQuota(householdId: string, billingOwnerUserId: string): Promise<void> {
    const max = await this.getCapability(billingOwnerUserId, "household_members_max");
    if (max === null || typeof max !== "number") return;

    const rows = await this.db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          inArray(schema.householdMemberships.status, ["active", "invited"]),
        ),
      );
    if (rows.length >= max) {
      throw new ForbiddenException({
        code: "HOUSEHOLD_MEMBER_LIMIT_REACHED",
        message: `This household's plan allows up to ${max} member${max === 1 ? "" : "s"}. Upgrade to add more.`,
      });
    }
  }
}
