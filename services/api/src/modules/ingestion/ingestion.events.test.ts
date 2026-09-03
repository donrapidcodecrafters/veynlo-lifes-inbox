import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type DomainEvent } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import { EventBusService } from "../../events/event-bus.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * Real integration test against a real Postgres, mirroring ingestion.dedup.test.ts's own shape (skips
 * gracefully with no reachable dev Postgres). Proves §42.3/42.4's foundational event-bus infrastructure is
 * genuinely wired into IngestionService, not just declared: a real `EventBusService` is passed in as the
 * (optional, trailing) constructor dependency, a listener is registered on it the same way a real consumer
 * would, and the actual ingestion call sites (`extractReceipt`, `extractBill`, `extractSubscription`) are
 * asserted to have fired the right typed event with the right payload — not mocked/stubbed emission.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService — real event-bus emission", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let events: EventBusService;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;
  let captured: DomainEvent[];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `ingestion-events-${ownerUserId}@example.com`, displayName: "Ingestion Events Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService event-bus tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  // 10 positional required deps, then 8 optional trailing deps (memories..analytics) left undefined, then
  // the real EventBusService as the 19th/last positional argument — see IngestionService's own constructor
  // doc comments for why `events` is appended last and typed optional.
  function newIngestionWithRealEventBus(): IngestionService {
    events = new EventBusService();
    captured = [];
    events.onAny((event) => {
      captured.push(event);
    });
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
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      events,
    );
  }

  it("fires PurchaseDetected.v1 and FactExtracted.v1 when a new receipt is extracted", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = newIngestionWithRealEventBus();

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
    ai.enqueue(
      "receipt_extraction_v1",
      fakeExtraction({
        merchantName: "Events Test Outfitters",
        orderNumber: "ORD-EVT-1",
        purchaseDate: { iso_date: "2026-09-01", approximate_text: null },
        totalAmountMinorUnits: 4_999,
        currency: "USD",
        taxMinorUnits: 300,
        shippingMinorUnits: 0,
        lineItems: [{ productLabel: "Trail running shoes", quantity: 1, unitPriceMinorUnits: 4_699 }],
        returnDeadline: null,
      }),
    );

    const { sourceEventId } = await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Events Test Outfitters order confirmation",
      bodyText: "Order ORD-EVT-1: Trail running shoes, $46.99. Total: $49.99.",
    });

    const purchaseEvents = captured.filter((e): e is Extract<DomainEvent, { type: "PurchaseDetected.v1" }> => e.type === "PurchaseDetected.v1");
    expect(purchaseEvents).toHaveLength(1);
    expect(purchaseEvents[0]!.ownerUserId).toBe(ownerUserId);
    expect(purchaseEvents[0]!.payload.merchantLabel).toBe("Events Test Outfitters");
    expect(purchaseEvents[0]!.payload.orderNumber).toBe("ORD-EVT-1");
    expect(purchaseEvents[0]!.payload.totalMinorUnits).toBe(4_999);
    expect(purchaseEvents[0]!.payload.sourceEventId).toBe(sourceEventId);

    // Cross-check the emitted event's aggregateId is the real purchase row's own id, not a placeholder.
    const [purchase] = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    expect(purchaseEvents[0]!.aggregateId).toBe(purchase!.id);

    const factEvents = captured.filter((e): e is Extract<DomainEvent, { type: "FactExtracted.v1" }> => e.type === "FactExtracted.v1");
    expect(factEvents).toHaveLength(1);
    expect(factEvents[0]!.payload.predicate).toBe("purchase_details");
    expect(factEvents[0]!.payload.sourceEventId).toBe(sourceEventId);
    expect(factEvents[0]!.payload.evidenceIds).toHaveLength(1);
  });

  it("fires PurchaseUpdated.v1 (not PurchaseDetected.v1 again) when a second email auto-merges into the same order", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = newIngestionWithRealEventBus();
    const orderNumber = "ORD-EVT-MERGE";

    for (let i = 0; i < 2; i++) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
      ai.enqueue(
        "receipt_extraction_v1",
        fakeExtraction({
          merchantName: "Events Test Outfitters",
          orderNumber,
          purchaseDate: { iso_date: "2026-09-02", approximate_text: null },
          totalAmountMinorUnits: 2_000,
          currency: "USD",
          taxMinorUnits: null,
          shippingMinorUnits: null,
          lineItems: i === 0 ? [{ productLabel: "Water bottle", quantity: 1, unitPriceMinorUnits: 2_000 }] : [],
          returnDeadline: null,
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? `Order ${orderNumber} confirmed` : `Order ${orderNumber} payment receipt`,
        bodyText: "Water bottle, $20.00.",
      });
    }

    expect(captured.filter((e) => e.type === "PurchaseDetected.v1")).toHaveLength(1);
    expect(captured.filter((e) => e.type === "PurchaseUpdated.v1")).toHaveLength(1);
  });

  it("fires BillDueChanged.v1 when a new bill is extracted", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = newIngestionWithRealEventBus();

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({
        billerName: "Events Test Power Co",
        amountDueMinorUnits: 7_700,
        currency: "USD",
        dueDate: { iso_date: "2026-10-05", approximate_text: null },
        autopayMentioned: false,
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Events Test Power Co bill is ready",
      bodyText: "Amount due: $77.00. Due date: October 5, 2026.",
    });

    const billEvents = captured.filter((e): e is Extract<DomainEvent, { type: "BillDueChanged.v1" }> => e.type === "BillDueChanged.v1");
    expect(billEvents).toHaveLength(1);
    expect(billEvents[0]!.payload.billerLabel).toBe("Events Test Power Co");
    expect(billEvents[0]!.payload.amountDueMinorUnits).toBe(7_700);
    expect(billEvents[0]!.payload.dueDateIso).toContain("2026-10-05");
    expect(billEvents[0]!.sensitivity).toBe("sensitive");
  });

  it("fires SubscriptionDetected.v1 on first sighting, then SubscriptionStatusChanged.v1 when the trial ends", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = newIngestionWithRealEventBus();

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
    ai.enqueue(
      "subscription_extraction_v1",
      fakeExtraction({
        serviceLabel: "Events Test Streamflix",
        merchantName: null,
        cadence: "monthly",
        amountMinorUnits: 1_299,
        currency: "USD",
        nextBillingDate: { iso_date: "2026-09-20", approximate_text: null },
        isTrial: true,
        trialEndsDate: { iso_date: "2026-09-20", approximate_text: null },
        cancellationInstructionsUrl: null,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Events Test Streamflix free trial started",
      bodyText: "Events Test Streamflix, $12.99/month after trial.",
    });

    const detected = captured.filter((e): e is Extract<DomainEvent, { type: "SubscriptionDetected.v1" }> => e.type === "SubscriptionDetected.v1");
    expect(detected).toHaveLength(1);
    expect(detected[0]!.payload.state).toBe("trial");
    expect(detected[0]!.payload.merchantLabel).toBe("Events Test Streamflix");

    // Second email: trial ends, renewal confirmed at the real (non-promo) price — same recurring stream,
    // no longer itself about the trial, so extractSubscription's own isTrialEndingTransition carve-out
    // moves state trial -> trial_ended.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["subscription"] }));
    ai.enqueue(
      "subscription_extraction_v1",
      fakeExtraction({
        serviceLabel: "Events Test Streamflix",
        merchantName: null,
        cadence: "monthly",
        amountMinorUnits: 1_299,
        currency: "USD",
        nextBillingDate: { iso_date: "2026-10-20", approximate_text: null },
        isTrial: false,
        trialEndsDate: null,
        cancellationInstructionsUrl: null,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Events Test Streamflix trial is ending — renewal confirmed",
      bodyText: "Events Test Streamflix renews at $12.99/month.",
    });

    const statusChanged = captured.filter((e): e is Extract<DomainEvent, { type: "SubscriptionStatusChanged.v1" }> => e.type === "SubscriptionStatusChanged.v1");
    expect(statusChanged).toHaveLength(1);
    expect(statusChanged[0]!.payload.previousState).toBe("trial");
    expect(statusChanged[0]!.payload.state).toBe("trial_ended");
    // Only one SubscriptionDetected.v1 total across both emails — the second email updates the existing
    // subscription rather than re-detecting a new one.
    expect(captured.filter((e) => e.type === "SubscriptionDetected.v1")).toHaveLength(1);
  });
});
