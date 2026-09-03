import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import { FeatureFlagsService } from "../feature-flags/feature-flags.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * §AI-003 kill switch — the single most safety-relevant piece of this session's work: a real,
 * DB-backed, admin-flippable `feature_flags` row (`ai_extraction_paused`) previously existed with no
 * reader anywhere near AI extraction, so flipping it did nothing. This proves, end to end against a real
 * Postgres, that setting the flag genuinely stops `IngestionService.classifyAndExtract` from ever calling
 * the model — not just that it discards the result, but that `FakeModelProvider.calls` stays completely
 * empty, i.e. the model is never even invoked once the flag is set — mirroring exactly how
 * `automation.service.test.ts`'s own "AUTO-010 kill switch" test proves the same thing for automation
 * (pause -> zero effect -> unpause -> normal effect resumes).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

const AI_EXTRACTION_PAUSED_FLAG_KEY = "ai_extraction_paused";

describe("IngestionService §AI-003 ai_extraction_paused kill switch", () => {
  let db: Database;
  let featureFlags: FeatureFlagsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `ai-kill-switch-test-${ownerUserId}@example.com`, displayName: "AI Kill Switch Test" });
      featureFlags = new FeatureFlagsService(db);
      // Known starting state — a key with no row is off (see FeatureFlagsService.isEnabled's own doc
      // comment), but another test/session may have left the real flag flipped on. Force it off before
      // this suite starts so the first assertion below is trustworthy.
      await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, false, "test setup");
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService AI kill-switch tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      // Leave the real flag off — the same state every other AI-extraction test in this repo assumes.
      await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, false, "test teardown");
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  function buildIngestion(ai: FakeModelProvider): IngestionService {
    return new IngestionService(
      db,
      ai,
      stubNotifications,
      stubStorage,
      stubMalwareScanner,
      stubEntitlements,
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
      undefined,
      undefined,
      undefined,
      featureFlags,
    );
  }

  it("a paused account calls the model ZERO times and files nothing, even though a matching response is queued and ready", async () => {
    if (!dbAvailable) return;
    expect(await featureFlags.isEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY)).toBe(false);
    await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, true, "test");
    expect(await featureFlags.isEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY)).toBe(true);

    const ai = new FakeModelProvider();
    const ingestion = buildIngestion(ai);
    // Queued and ready to answer — if the kill switch is genuinely checked BEFORE any AI call, this must
    // never be consumed. If it silently fell through, the classifier would happily return it.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Kill Switch Test Utility", amountDueMinorUnits: 1_234, currency: "USD", dueDate: { iso_date: "2026-11-01", approximate_text: null }, autopayMentioned: false }),
    );

    const { sourceEventId } = await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Kill Switch Test Utility bill",
      bodyText: "Amount due: $12.34.",
    });

    // The load-bearing assertion: the model provider was never invoked at all, for ANY extractor —
    // proving this is a genuine pre-call gate, not a post-hoc discard of a result that was still fetched.
    expect(ai.calls).toEqual([]);

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.filter((b) => b.amountDueMinorUnits === 1_234)).toHaveLength(0);

    const [event] = await db.select({ processingState: schema.sourceEvents.processingState }).from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId));
    expect(event?.processingState).toBe("filed");
  });

  it("unpausing lets the very next ingestion call the model again and file normally", async () => {
    if (!dbAvailable) return;
    await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, false, "test");
    expect(await featureFlags.isEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY)).toBe(false);

    const ai = new FakeModelProvider();
    const ingestion = buildIngestion(ai);
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Kill Switch Test Utility Resumed", amountDueMinorUnits: 5_678, currency: "USD", dueDate: { iso_date: "2026-11-15", approximate_text: null }, autopayMentioned: false }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Kill Switch Test Utility Resumed bill",
      bodyText: "Amount due: $56.78.",
    });

    expect(ai.calls).toEqual(["domain_classifier_v1", "bill_extraction_v1"]);
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.filter((b) => b.amountDueMinorUnits === 5_678)).toHaveLength(1);
  });

  it("the share-message classification entry point (classifyAndRouteShareMessage) is also stopped while paused", async () => {
    if (!dbAvailable) return;
    await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, true, "test");

    const ai = new FakeModelProvider();
    const ingestion = buildIngestion(ai);
    ai.enqueue("share_message_classifier_v1", fakeExtraction({ category: "note", title: "Kill switch share test", noteText: "Some shared text.", taskDescription: null, dateIso: null, addressText: null, personMentioned: null }));

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Shared",
      bodyText: "Some shared text about a kill-switch share test.",
      kind: "share_capture",
    });

    expect(ai.calls).toEqual([]);

    await featureFlags.setEnabled(AI_EXTRACTION_PAUSED_FLAG_KEY, false, "test");
  });
});
