import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { OnboardingService } from "./onboarding.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";

/**
 * ONB-001/ONB-002 real-Postgres regression coverage. Three things the onboarding brief specifically calls
 * out for testing, all exercised against a real database rather than mocks:
 *   1. onboarding_state persists and resumes correctly across a simulated interruption (a brand-new
 *      OnboardingService instance backed by a fresh db client — the same shape a server restart or a
 *      different request would see — must read back exactly where the first instance left off).
 *   2. Historical-depth options are gated by entitlement tier (Free vs Plus), and a disallowed choice is
 *      rejected server-side, not just hidden client-side.
 *   3. Skipping at any step reaches a state a Home-gating check reads as "no redirect needed"
 *      (`needsOnboarding: false`) — the backend half of "never trap the user".
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };

describe("OnboardingService", () => {
  let db: Database;
  let entitlements: EntitlementsService;
  let dbAvailable = true;
  const createdUserIds: string[] = [];
  const createdConnectionIds: string[] = [];
  const createdInboxItemIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    entitlements = new EntitlementsService(db, noopCache);
    try {
      await db.select().from(schema.users).limit(1);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping OnboardingService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdInboxItemIds) await db.delete(schema.inboxItems).where(eq(schema.inboxItems.id, id));
    for (const id of createdConnectionIds) await db.delete(schema.connections).where(eq(schema.connections.id, id));
    for (const id of createdUserIds) await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  async function makeUser(): Promise<string> {
    const userId = generateId("user");
    await db.insert(schema.users).values({ id: userId, email: `onboarding-test-${userId}@example.com`, displayName: "Onboarding Test" });
    createdUserIds.push(userId);
    return userId;
  }

  it("creates a resumable row at sign-up time, and reads back the same step/goal from a brand-new service instance (simulated restart)", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(userId);

    const initial = await onboarding.getState(userId);
    expect(initial.needsOnboarding).toBe(true);
    expect(initial.currentStep).toBe("goal_selection");

    await onboarding.setGoal(userId, "purchases_returns");

    // Simulates "the process restarted" / "a different request handled the next call" — a fresh instance
    // with its own fresh db connection, not the same in-memory object, reading the same row back.
    const reconnected = new OnboardingService(createDbClient(DATABASE_URL), entitlements);
    const resumed = await reconnected.getState(userId);
    expect(resumed.currentStep).toBe("pre_permission");
    expect(resumed.goal).toBe("purchases_returns");
    expect(resumed.recommendedConnector).toBe("gmail");
  });

  it("falls back bills_subscriptions' Plaid recommendation to Gmail when Plaid isn't configured on this deployment", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(userId);

    const result = await onboarding.setGoal(userId, "bills_subscriptions");
    // This dev environment's .env has no PLAID_CLIENT_ID/PLAID_SECRET set (confirmed via services/api/.env),
    // so the documented fallback should kick in rather than recommending an unusable connector.
    expect(result.recommendedConnector).toBe("gmail");
    // Real bug found live via Playwright: the reason text used to always describe the goal's PRIMARY
    // recommendation ("connect a bank or card account"), even after silently falling back to Gmail — a
    // user would see that bank-account copy directly above a screen asking for Gmail access instead. The
    // reason shown must match what's actually being asked for.
    expect(result.recommendationReason).toMatch(/gmail/i);
    // The bug specifically: the reason describing the ASK must not still be worded as if a bank/card
    // account is what's being requested, once the actual ask has become Gmail access.
    expect(result.recommendationReason).not.toMatch(/^connect a bank or card account/i);
  });

  it("recommends household setup (no connector) for the family goal, with no historical-depth step needed", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(userId);
    const result = await onboarding.setGoal(userId, "family");
    expect(result.recommendedConnector).toBe("household");
  });

  it("ONB-002: Free tier is limited to forward-only/30/90 days; Plus+ unlocks 6 months/1 year/build-my-history", async () => {
    if (!dbAvailable) return;
    const freeUserId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(freeUserId);
    await onboarding.setGoal(freeUserId, "travel");

    const freeState = await onboarding.getState(freeUserId);
    expect(freeState.allowedHistoryDepthChoices).toEqual(["forward_only", "days_30", "days_90"]);

    // A Free user requesting a locked depth is rejected server-side (not just hidden in the UI) —
    // confirms the entitlement check is real enforcement, not cosmetic.
    await expect(onboarding.setHistoryDepth(freeUserId, "year_1")).rejects.toThrow();

    // An allowed choice resolves to exactly that many days (PLAN_CATALOG.free.historical_backfill_days
    // is 90 — ONB-002's own "Free tier gets ... 90 days" ceiling — so nothing gets silently clamped lower).
    const chosen = await onboarding.setHistoryDepth(freeUserId, "days_90");
    expect(chosen.resolvedDays).toBe(90);

    // Grant this second user a Plus entitlement directly (bypassing billing) to prove the *entitlement*,
    // not the plan name, drives the gate.
    const plusUserId = await makeUser();
    await onboarding.initializeForNewUser(plusUserId);
    await onboarding.setGoal(plusUserId, "travel");
    await db.insert(schema.entitlements).values({
      id: generateId("entitlement"),
      userId: plusUserId,
      householdId: null,
      planKey: "plus",
      source: "promotional",
      effectiveFrom: new Date(Date.now() - 60_000),
      effectiveTo: null,
      reason: "onboarding test fixture",
    });

    const plusState = await onboarding.getState(plusUserId);
    expect(plusState.allowedHistoryDepthChoices).toEqual(["forward_only", "days_30", "days_90", "months_6", "year_1", "build_history"]);

    const plusChoice = await onboarding.setHistoryDepth(plusUserId, "year_1");
    expect(plusChoice.resolvedDays).toBe(365);

    // "build my history" is offered to Plus (unlike Free), even though Plus's real numeric cap (365) means
    // it resolves to the same 365 days as "1 year" rather than a literal unlimited backfill — see
    // OnboardingService's own doc comment on this deliberate "offered, but clamped to the plan's real cap"
    // posture, distinct from pro_agent's actual unlimited.
    const plusBuildHistory = await onboarding.setHistoryDepth(plusUserId, "build_history");
    expect(plusBuildHistory.resolvedDays).toBe(365);
  });

  it("scanProgress reports a graceful zero-discovery completion when a bounded scan finds nothing (e.g. AI extraction not configured)", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(userId);
    await onboarding.setGoal(userId, "purchases_returns");
    await onboarding.setHistoryDepth(userId, "days_30");

    // A real connection row, as if a connector's handleCallback had already run — health starts
    // "initializing" exactly like GmailAdapter/OutlookAdapter leave it until initialSync finishes.
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: userId,
      householdId: null,
      provider: "gmail",
      feasibilityClass: "direct_api",
      health: "initializing",
    });
    createdConnectionIds.push(connectionId);

    await onboarding.startScan(userId, connectionId);
    const midScan = await onboarding.scanProgress(userId);
    expect(midScan.status).toBe("scanning");
    expect(midScan.discoveredCount).toBe(0);

    // Simulates the connector adapter finishing initialSync with zero relevant items (exactly what happens
    // with ANTHROPIC_API_KEY unset — IngestionService.classifyAndExtract files nothing when the AI
    // classifier isn't configured and no known-sender match exists) — health flips to healthy, no
    // inbox_items were ever created.
    await db.update(schema.connections).set({ health: "healthy", lastSuccessfulSyncAt: new Date() }).where(eq(schema.connections.id, connectionId));

    const done = await onboarding.scanProgress(userId);
    expect(done.status).toBe("complete");
    expect(done.discoveredCount).toBe(0);
  });

  it("scanProgress counts real inbox_items created since the scan started, ignoring anything from before", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(userId);
    await onboarding.setGoal(userId, "purchases_returns");
    await onboarding.setHistoryDepth(userId, "days_30");

    // An item that predates the scan (e.g. from a manual/forwarded capture) must not be counted as a
    // discovery of THIS scan.
    const staleItemId = generateId("inboxItem");
    await db.insert(schema.inboxItems).values({
      id: staleItemId,
      ownerUserId: userId,
      householdId: null,
      category: "receipt",
      summary: "pre-existing item",
      sourceEventId: generateId("sourceEvent"),
      suggestedActions: [],
      confidenceBand: "high",
      createdAt: new Date(Date.now() - 3600_000),
    });
    createdInboxItemIds.push(staleItemId);

    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: userId,
      householdId: null,
      provider: "gmail",
      feasibilityClass: "direct_api",
      health: "initializing",
    });
    createdConnectionIds.push(connectionId);
    await onboarding.startScan(userId, connectionId);

    const freshItemId = generateId("inboxItem");
    await db.insert(schema.inboxItems).values({
      id: freshItemId,
      ownerUserId: userId,
      householdId: null,
      category: "receipt",
      summary: "discovered during this scan",
      sourceEventId: generateId("sourceEvent"),
      suggestedActions: [],
      confidenceBand: "high",
    });
    createdInboxItemIds.push(freshItemId);

    const progress = await onboarding.scanProgress(userId);
    expect(progress.discoveredCount).toBe(1);
  });

  it("skip() is reachable from any step and results in needsOnboarding: false — the signal the Home-gating layout check relies on to stop redirecting", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser();
    const onboarding = new OnboardingService(db, entitlements);
    await onboarding.initializeForNewUser(userId);

    // Skip straight from goal_selection, the very first step.
    const skipped = await onboarding.skip(userId);
    expect(skipped.needsOnboarding).toBe(false);
    expect(skipped.currentStep).toBe("completed");

    // Also reachable mid-flow: a second user who's progressed a few steps in.
    const midFlowUserId = await makeUser();
    await onboarding.initializeForNewUser(midFlowUserId);
    await onboarding.setGoal(midFlowUserId, "things_i_own");
    await onboarding.setStep(midFlowUserId, "household_invite");
    const midFlowSkipped = await onboarding.skip(midFlowUserId);
    expect(midFlowSkipped.needsOnboarding).toBe(false);
  });

  it("a pre-existing account with no onboarding_state row is never retroactively forced into onboarding", async () => {
    if (!dbAvailable) return;
    const userId = await makeUser(); // deliberately never calls initializeForNewUser
    const onboarding = new OnboardingService(db, entitlements);
    const state = await onboarding.getState(userId);
    expect(state.needsOnboarding).toBe(false);

    // Every mutation route 404s (via NotFoundException) for such an account rather than lazily creating a
    // row — onboarding is opt-in-by-signup-time only.
    await expect(onboarding.setGoal(userId, "travel")).rejects.toThrow();
  });
});
