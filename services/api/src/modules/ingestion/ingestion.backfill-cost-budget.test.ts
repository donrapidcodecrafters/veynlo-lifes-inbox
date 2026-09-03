import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * §47.4 "Low-priority historical imports are batched and can pause under global/model/provider budget
 * pressure; current critical sources are prioritized" / §39.2 "Defer low-priority historical enrichment
 * before degrading critical current processing." — real, DB-backed proof, mirroring
 * ingestion.ai-kill-switch.test.ts's exact structure (real Postgres, a real FeatureFlagsService, a
 * FakeModelProvider whose `.calls` staying empty is the load-bearing assertion) that:
 *   1. Once a user's current-period AI cost crosses the configured threshold AND the flag is enabled,
 *      a BACKFILL-triggered extraction (`isBackfill: true`, as GmailAdapter.initialSync sets) is genuinely
 *      never sent to the model at all — not just discarded after the fact.
 *   2. The SAME user's LIVE (non-backfill) extraction still goes through completely normally — this
 *      mechanism must never throttle real-time inbox processing, only deferrable historical backfill.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };

const BACKFILL_COST_BUDGET_FLAG_KEY = "backfill_cost_budget_paused";
const AI_EXTRACTION_PAUSED_FLAG_KEY = "ai_extraction_paused";

/** Minimal `gmail_v1.Schema$Message` — exactly the shape `parseGmailMessage` (gmail-message-parser.ts)
 * reads: headers for from/subject/date, a plain-text body part, and `snippet`. Copied from
 * ingestion.connection-privacy.test.ts's identical helper. */
function fakeGmailMessage(opts: { id: string; from: string; subject: string; bodyText: string }) {
  return {
    id: opts.id,
    snippet: opts.bodyText.slice(0, 100),
    payload: {
      headers: [
        { name: "From", value: opts.from },
        { name: "Subject", value: opts.subject },
        { name: "Date", value: new Date().toUTCString() },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(opts.bodyText, "utf8").toString("base64url") },
    },
  } as unknown as Parameters<IngestionService["ingestGmailMessage"]>[0]["message"];
}

describe("IngestionService §47.4 backfill-specific cost-budget pause", () => {
  let db: Database;
  let featureFlags: FeatureFlagsService;
  let entitlements: EntitlementsService;
  let ownerUserId: string;
  let connectionId: string;
  let extractorVersionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      featureFlags = new FeatureFlagsService(db);
      entitlements = new EntitlementsService(db, noopCache);

      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `backfill-cost-budget-test-${ownerUserId}@example.com`, displayName: "Backfill Cost Budget Test" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider: "gmail", feasibilityClass: "direct_api" });

      // Seed this user's current-period AI spend WELL above the threshold this test configures below — a
      // real `extraction_runs.costMinorUnits` row, the same shape AnthropicExtractionService.finishRun
      // actually writes (see anthropic-extraction.service.test.ts's §47.4 cost tests), not a synthetic
      // shortcut.
      extractorVersionId = generateId("extractorVersion");
      await db.insert(schema.extractorVersions).values({ id: extractorVersionId, stage: "extraction", name: "backfill_cost_budget_seed_v1", version: "1", modelKey: "claude-haiku-4-5-20251001" });
      const priorSourceEventId = generateId("sourceEvent");
      await db.insert(schema.sourceEvents).values({
        id: priorSourceEventId,
        ownerUserId,
        kind: "email_message",
        contentHash: priorSourceEventId,
        occurredAt: new Date(),
        idempotencyKey: `backfill-cost-budget-seed:${priorSourceEventId}`,
      });
      await db.insert(schema.extractionRuns).values({
        id: generateId("extractionRun"),
        sourceEventId: priorSourceEventId,
        stage: "extraction",
        extractorVersionId,
        status: "success",
        costMinorUnits: 10_000, // $100.00 already spent this period
      });

      // Known starting state for both flags, regardless of what a prior test/session left behind.
      await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, false, "test setup");
      await featureFlags.setEnabled(BACKFILL_COST_BUDGET_FLAG_KEY, true, "test setup — backfill cost-pressure pause", "5000"); // $50.00 threshold, already exceeded above
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping backfill cost-budget pause tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await featureFlags.setEnabled(BACKFILL_COST_BUDGET_FLAG_KEY, false, "test teardown");
      await db.delete(schema.extractionRuns).where(eq(schema.extractionRuns.extractorVersionId, extractorVersionId));
      await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
      await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  // `IngestionService.classifyAndExtract` also gates the "bill" domain on
  // `entitlements.getCapability(..., "subscriptions_bills_tracking")`, unrelated to this feature — a real
  // `EntitlementsService` resolves that against this test user's (nonexistent) plan entitlements and
  // returns the free-tier `false`, which would block bill extraction for a reason that has nothing to do
  // with the cost-budget gate under test. Same permissive-stub shape every other ingestion test in this repo
  // uses for unrelated capability checks (see ingestion.connection-privacy.test.ts's `stubEntitlements`),
  // but with `currentPeriodAiCostMinorUnits` delegated to the REAL `EntitlementsService` instance — that's
  // the one method this test suite actually needs to be genuine.
  function buildIngestion(ai: FakeModelProvider): IngestionService {
    const ingestionEntitlements = {
      assertStorageQuota: async () => {},
      getCapability: async () => true,
      currentPeriodAiCostMinorUnits: (userId: string, periodStart?: Date) => entitlements.currentPeriodAiCostMinorUnits(userId, periodStart),
    } as unknown as EntitlementsService;
    return new IngestionService(
      db,
      ai,
      stubNotifications,
      stubStorage,
      stubMalwareScanner,
      ingestionEntitlements,
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
      undefined, // memories
      undefined, // documents
      undefined, // riskPolicy
      featureFlags,
    );
  }

  it("a backfill-triggered extraction is deferred: the model is called ZERO times once this user's cost exceeds the configured threshold", async () => {
    if (!dbAvailable) return;
    expect(await featureFlags.isEnabled(BACKFILL_COST_BUDGET_FLAG_KEY)).toBe(true);
    expect(await entitlements.currentPeriodAiCostMinorUnits(ownerUserId)).toBeGreaterThanOrEqual(5_000);

    const ai = new FakeModelProvider();
    // Queued and ready to answer — if the gate is genuinely checked BEFORE any AI call, this must never be
    // consumed, mirroring ingestion.ai-kill-switch.test.ts's exact "queued but never fetched" proof shape.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Backfill Budget Test Utility", amountDueMinorUnits: 1_111, currency: "USD", dueDate: { iso_date: "2026-11-01", approximate_text: null }, autopayMentioned: false }),
    );

    await buildIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `backfill-paused-${connectionId}`, from: "billing@backfillbudgettest.example", subject: "Payment due reminder", bodyText: "Payment due: $11.11." }),
      isBackfill: true,
    });

    // The load-bearing assertion: the model provider was never invoked at all — a genuine pre-call gate,
    // not a post-hoc discard of a result that was still fetched.
    expect(ai.calls).toEqual([]);

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.filter((b) => b.amountDueMinorUnits === 1_111)).toHaveLength(0);

    const [event] = await db
      .select({ processingState: schema.sourceEvents.processingState })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, `gmail:backfill-paused-${connectionId}`));
    expect(event?.processingState).toBe("filed");
  });

  it("a LIVE (non-backfill) extraction for the SAME over-budget user still goes through completely normally", async () => {
    if (!dbAvailable) return;
    expect(await featureFlags.isEnabled(BACKFILL_COST_BUDGET_FLAG_KEY)).toBe(true);
    expect(await entitlements.currentPeriodAiCostMinorUnits(ownerUserId)).toBeGreaterThanOrEqual(5_000);

    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Backfill Budget Test Utility Live", amountDueMinorUnits: 2_222, currency: "USD", dueDate: { iso_date: "2026-11-02", approximate_text: null }, autopayMentioned: false }),
    );

    // `isBackfill` omitted entirely — the same shape a live webhook/incrementalSync-triggered call uses.
    await buildIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `live-not-paused-${connectionId}`, from: "billing@backfillbudgettest2.example", subject: "Payment due reminder", bodyText: "Payment due: $22.22." }),
    });

    expect(ai.calls).toEqual(["domain_classifier_v1", "bill_extraction_v1"]);
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 2_222)).toBe(true);
  });

  it("with the flag disabled, a backfill-triggered extraction for the SAME over-budget user goes through normally (the automatic gate is opt-in)", async () => {
    if (!dbAvailable) return;
    await featureFlags.setEnabled(BACKFILL_COST_BUDGET_FLAG_KEY, false, "test — verifying opt-in default");

    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Backfill Budget Test Utility Disabled", amountDueMinorUnits: 3_333, currency: "USD", dueDate: { iso_date: "2026-11-03", approximate_text: null }, autopayMentioned: false }),
    );

    await buildIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `backfill-flag-off-${connectionId}`, from: "billing@backfillbudgettest3.example", subject: "Payment due reminder", bodyText: "Payment due: $33.33." }),
      isBackfill: true,
    });

    expect(ai.calls).toEqual(["domain_classifier_v1", "bill_extraction_v1"]);
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 3_333)).toBe(true);

    // Restore the enabled state the other tests in this file assume, in case test order ever changes.
    await featureFlags.setEnabled(BACKFILL_COST_BUDGET_FLAG_KEY, true, "test setup — backfill cost-pressure pause", "5000");
  });
});
