import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, gte } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type {
  ConnectorRecommendation,
  OnboardingGoal,
  OnboardingHistoryDepthChoice,
  OnboardingStep,
} from "./dto";

/**
 * ONB-001 "recommends one useful source" — a plain lookup table, deliberately not a model call (the spec
 * doesn't ask for AI-driven recommendation, just a sensible default path per goal). `bills_subscriptions`
 * is the one goal with a real fallback: Plaid is the ideal source for bills/subscriptions, but it's a paid
 * partner integration that may not be configured on every deployment, so this falls back to Gmail (bills
 * arrive by email too) exactly like the onboarding brief specifies.
 */
const GOAL_RECOMMENDATIONS: Record<
  OnboardingGoal,
  { connector: ConnectorRecommendation; fallback?: ConnectorRecommendation; reason: string; fallbackReason?: string }
> = {
  important_dates: {
    connector: "gmail",
    reason: "Connect Gmail so we can find upcoming events, appointment confirmations, and other important dates in your inbox.",
  },
  purchases_returns: {
    connector: "gmail",
    reason: "Connect Gmail so we can find your receipts, orders, and return windows.",
  },
  bills_subscriptions: {
    connector: "plaid",
    fallback: "gmail",
    reason: "Connect a bank or card account so we can track bills and subscriptions as they post.",
    // Shown instead of `reason` when Plaid isn't configured and this falls back to Gmail — otherwise a
    // user would see this screen ask for Gmail access right under text that still talks about a bank
    // account (found live: exactly this mismatch renders when PLAID_CLIENT_ID is unset).
    fallbackReason:
      "Bank connections aren't set up on this deployment yet, so we'll use Gmail instead — bills and subscription confirmations often land there too.",
  },
  family: {
    connector: "household",
    reason: "Set up your household so everyone in your family can see what matters.",
  },
  travel: {
    connector: "gmail",
    reason: "Connect Gmail so we can find your flight, hotel, and rental car confirmations.",
  },
  things_i_own: {
    connector: "manual_asset",
    reason: "Add a vehicle or property to start tracking warranties, registrations, and service history.",
  },
};

/** Picks the reason text matching what's actually being asked for — `GOAL_RECOMMENDATIONS[goal].reason`
 * describes the goal's PRIMARY recommendation, which is wrong to show once `setGoal` has already degraded
 * to that goal's documented fallback (see the `fallbackReason` doc comment above). */
function recommendationReasonFor(goal: OnboardingGoal, actualConnector: ConnectorRecommendation | null): string {
  const rec = GOAL_RECOMMENDATIONS[goal];
  if (actualConnector && actualConnector !== rec.connector && rec.fallbackReason) return rec.fallbackReason;
  return rec.reason;
}

/** ONB-002's own named options, mapped to the day count `EntitlementsService.resolveHistoricalBackfillDays`
 * clamps against. "forward_only" is 0 (no backfill — new items only, from here forward). */
const HISTORY_DEPTH_DAYS: Record<OnboardingHistoryDepthChoice, number> = {
  forward_only: 0,
  days_30: 30,
  days_90: 90,
  months_6: 182,
  year_1: 365,
  build_history: 3650,
};

/** Real, specific consent copy for the pre-permission screen (ONB-001: "Pre-permission screen must
 * explain exact reason and category. Do not ask for unrelated scopes.") — sourced from the same scope
 * constants the adapters actually request, not a separate hand-maintained description that could drift. */
const CONSENT_PREVIEWS: Record<"gmail" | "outlook" | "plaid", { title: string; scopes: string[]; explanation: string; notRequested: string[] }> = {
  gmail: {
    title: "Read-only access to your Gmail",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    explanation:
      "Veynlo will read your Gmail messages to find receipts, bills, trip confirmations, and other items worth tracking. We never send email as you, delete anything, or touch other Google products.",
    notRequested: ["Sending email", "Deleting email", "Contacts", "Google Drive", "Google Calendar"],
  },
  outlook: {
    title: "Read-only access to your Outlook mail",
    scopes: ["offline_access", "Mail.Read"],
    explanation:
      "Veynlo will read your Outlook/Microsoft 365 mail to find receipts, bills, trip confirmations, and other items worth tracking. We never send mail as you or delete anything.",
    notRequested: ["Sending mail", "Deleting mail", "Contacts", "OneDrive", "Microsoft Calendar"],
  },
  plaid: {
    title: "Read-only access to your bank/card transactions",
    scopes: ["transactions"],
    explanation:
      "Veynlo will connect through Plaid to read your transaction history so bills and subscriptions can be tracked automatically. Veynlo cannot move money, make payments, or view your login credentials — Plaid never shares those with us.",
    notRequested: ["Payments/transfers", "Account login credentials", "Identity/investment data"],
  },
};

export interface OnboardingStateResponse {
  needsOnboarding: boolean;
  currentStep: OnboardingStep;
  goal: OnboardingGoal | null;
  recommendedConnector: ConnectorRecommendation | null;
  recommendationReason: string | null;
  historyDepthChoice: OnboardingHistoryDepthChoice | null;
  allowedHistoryDepthChoices: OnboardingHistoryDepthChoice[];
  scanConnectionId: string | null;
  householdInviteOfferedAt: string | null;
  completedAt: string | null;
  aiConfigured: boolean;
}

@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  /** Creates the resumable onboarding row for a brand-new account. Called once, from
   * IdentityService.signUp / findOrCreateOAuthUser — never lazily on read, so a pre-existing account
   * (created before this feature shipped) never gets a row and is correctly reported as
   * `needsOnboarding: false` below, rather than being retroactively dropped into a first-run flow. */
  async initializeForNewUser(userId: string): Promise<void> {
    await this.db.insert(schema.onboardingState).values({ id: generateId("onboardingState"), userId });
  }

  private async getRow(userId: string) {
    const [row] = await this.db.select().from(schema.onboardingState).where(eq(schema.onboardingState.userId, userId)).limit(1);
    return row ?? null;
  }

  private async allowedChoicesFor(userId: string): Promise<OnboardingHistoryDepthChoice[]> {
    const cap = await this.entitlements.getCapability(userId, "historical_backfill_days");
    const capDays = typeof cap === "number" ? cap : null; // null = unlimited (pro_agent)
    const basic: OnboardingHistoryDepthChoice[] = ["forward_only", "days_30", "days_90"];
    const expanded: OnboardingHistoryDepthChoice[] = [...basic, "months_6", "year_1", "build_history"];
    // §46/ONB-002 "Free limited; Plus+ expanded" — Free's own cap (90 days, see PLAN_CATALOG) is exactly
    // the basic set's ceiling, so anything strictly above it means a paid tier.
    return capDays === null || capDays > 90 ? expanded : basic;
  }

  async getState(userId: string): Promise<OnboardingStateResponse> {
    const row = await this.getRow(userId);
    const allowedHistoryDepthChoices = await this.allowedChoicesFor(userId);
    if (!row) {
      return {
        needsOnboarding: false,
        currentStep: "completed",
        goal: null,
        recommendedConnector: null,
        recommendationReason: null,
        historyDepthChoice: null,
        allowedHistoryDepthChoices,
        scanConnectionId: null,
        householdInviteOfferedAt: null,
        completedAt: null,
        aiConfigured: Boolean(loadEnv().ANTHROPIC_API_KEY),
      };
    }
    return {
      needsOnboarding: row.currentStep !== "completed",
      currentStep: row.currentStep,
      goal: row.goal,
      recommendedConnector: (row.recommendedConnector as ConnectorRecommendation | null) ?? null,
      recommendationReason: row.goal ? recommendationReasonFor(row.goal, row.recommendedConnector as ConnectorRecommendation | null) : null,
      historyDepthChoice: row.historyDepthChoice,
      allowedHistoryDepthChoices,
      scanConnectionId: row.scanConnectionId,
      householdInviteOfferedAt: row.householdInviteOfferedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      aiConfigured: Boolean(loadEnv().ANTHROPIC_API_KEY),
    };
  }

  private async requireRow(userId: string) {
    const row = await this.getRow(userId);
    if (!row) {
      // A pre-existing account (no onboarding row) hitting one of the mutation endpoints below — nothing
      // to resume, and nothing should be created lazily (see initializeForNewUser's doc comment).
      throw new NotFoundException({ code: "ONBOARDING_NOT_APPLICABLE", message: "Onboarding isn't available for this account." });
    }
    return row;
  }

  async setGoal(userId: string, goal: OnboardingGoal): Promise<OnboardingStateResponse> {
    await this.requireRow(userId);
    const rec = GOAL_RECOMMENDATIONS[goal];
    let connector = rec.connector;
    // bills_subscriptions' Plaid-first recommendation degrades to its documented Gmail fallback when
    // Plaid isn't configured on this deployment — same "explain exactly what will happen, don't dead-end
    // on a disabled button" posture as everywhere else a connector's isConfigured() gate is checked.
    if (connector === "plaid" && !isConnectorConfigured("plaid") && rec.fallback) {
      connector = rec.fallback;
    }
    await this.db
      .update(schema.onboardingState)
      .set({ goal, recommendedConnector: connector, currentStep: "pre_permission", updatedAt: new Date() })
      .where(eq(schema.onboardingState.userId, userId));
    return this.getState(userId);
  }

  consentPreview(connector: "gmail" | "outlook" | "plaid") {
    return CONSENT_PREVIEWS[connector];
  }

  async setHistoryDepth(userId: string, choice: OnboardingHistoryDepthChoice): Promise<{ choice: OnboardingHistoryDepthChoice; requestedDays: number; resolvedDays: number }> {
    await this.requireRow(userId);
    const allowed = await this.allowedChoicesFor(userId);
    if (!allowed.includes(choice)) {
      throw new ForbiddenException({
        code: "HISTORY_DEPTH_REQUIRES_UPGRADE",
        message: "This depth of history is available on Plus and above. Upgrade to unlock it, or pick a shorter window.",
      });
    }
    const requestedDays = HISTORY_DEPTH_DAYS[choice];
    const resolvedDays = await this.entitlements.resolveHistoricalBackfillDays(userId, requestedDays);
    await this.db
      .update(schema.onboardingState)
      .set({ historyDepthChoice: choice, currentStep: "connecting", updatedAt: new Date() })
      .where(eq(schema.onboardingState.userId, userId));
    return { choice, requestedDays, resolvedDays };
  }

  /** Returns the day count to actually request from a connector's `/authorize` (or Plaid's exchange
   * request) for the depth this user already chose on the historical-depth step — 90 (the plan's default
   * full allowance) if they haven't chosen one yet, e.g. connecting straight from goal selection. */
  async resolveChosenHistoryDepthDays(userId: string): Promise<number | undefined> {
    const row = await this.getRow(userId);
    if (!row?.historyDepthChoice) return undefined;
    return HISTORY_DEPTH_DAYS[row.historyDepthChoice];
  }

  async startScan(userId: string, connectionId: string): Promise<OnboardingStateResponse> {
    await this.requireRow(userId);
    const [connection] = await this.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.ownerUserId, userId)))
      .limit(1);
    if (!connection) throw new BadRequestException({ code: "CONNECTION_NOT_FOUND", message: "That connection doesn't belong to this account." });
    await this.db
      .update(schema.onboardingState)
      .set({ scanConnectionId: connectionId, scanStartedAt: new Date(), currentStep: "scanning", updatedAt: new Date() })
      .where(eq(schema.onboardingState.userId, userId));
    return this.getState(userId);
  }

  /**
   * ONB-001 "returns progress in resumable stages" — real progress, not a synthetic tracker: polls the
   * same `connections.health`/`itemsDiscoveredCount` the connector adapters themselves write at the end of
   * `initialSync`, plus a live count of `inbox_items` this scan has actually filed (created at/after
   * `scanStartedAt`) — the ingestion pipeline's own real output, exactly as it exists for every other
   * connector sync, not a parallel progress-tracking mechanism built just for onboarding.
   */
  async scanProgress(userId: string): Promise<{ status: "not_started" | "scanning" | "complete" | "failed"; discoveredCount: number }> {
    const row = await this.getRow(userId);
    if (!row?.scanConnectionId || !row.scanStartedAt) return { status: "not_started", discoveredCount: 0 };

    const [connection] = await this.db
      .select({ health: schema.connections.health })
      .from(schema.connections)
      .where(eq(schema.connections.id, row.scanConnectionId))
      .limit(1);

    const discoveredRows = await this.db
      .select({ id: schema.inboxItems.id })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, userId), gte(schema.inboxItems.createdAt, row.scanStartedAt)));

    if (!connection) return { status: "failed", discoveredCount: discoveredRows.length };
    if (connection.health === "healthy") return { status: "complete", discoveredCount: discoveredRows.length };
    if (connection.health === "degraded" || connection.health === "disconnected") return { status: "failed", discoveredCount: discoveredRows.length };
    return { status: "scanning", discoveredCount: discoveredRows.length };
  }

  async setStep(userId: string, step: OnboardingStep): Promise<OnboardingStateResponse> {
    await this.requireRow(userId);
    const patch: Partial<typeof schema.onboardingState.$inferInsert> = { currentStep: step, updatedAt: new Date() };
    if (step === "completed") patch.completedAt = new Date();
    await this.db.update(schema.onboardingState).set(patch).where(eq(schema.onboardingState.userId, userId));
    return this.getState(userId);
  }

  async recordHouseholdInviteOffered(userId: string): Promise<OnboardingStateResponse> {
    await this.requireRow(userId);
    await this.db
      .update(schema.onboardingState)
      .set({ householdInviteOfferedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.onboardingState.userId, userId));
    return this.getState(userId);
  }

  /** ONB-001 "skip optional setup" — always reachable, from any step: sets `completedAt` so the flow never
   * shows again and the user lands on a normal Home page exactly as they would have with no onboarding
   * feature at all. */
  async skip(userId: string): Promise<OnboardingStateResponse> {
    await this.requireRow(userId);
    const now = new Date();
    await this.db
      .update(schema.onboardingState)
      .set({ skippedAt: now, completedAt: now, currentStep: "completed", updatedAt: now })
      .where(eq(schema.onboardingState.userId, userId));
    return this.getState(userId);
  }

  async complete(userId: string): Promise<OnboardingStateResponse> {
    return this.setStep(userId, "completed");
  }
}
