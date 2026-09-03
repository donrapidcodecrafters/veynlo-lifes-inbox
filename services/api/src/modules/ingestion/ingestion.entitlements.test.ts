import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * §46 "plan gates purchases/returns and subscriptions/bills tracking" — real integration test against the
 * real dev Postgres, same shape as ingestion.dedup.test.ts. Uses a stub EntitlementsService (not the real
 * DB-backed one) so the gate itself — not entitlement *resolution* — is what's under test: the real
 * resolution logic already has its own coverage via EntitlementsService's own call sites elsewhere.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;

function entitlementsStub(capabilities: Record<string, boolean>): EntitlementsService {
  return { getCapability: async (_userId: string, key: string) => capabilities[key] ?? true } as unknown as EntitlementsService;
}

describe("IngestionService entitlement gating (purchases_returns_tracking / subscriptions_bills_tracking)", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `entitlement-gate-test-${ownerUserId}@example.com`, displayName: "Entitlement Gate Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping entitlement-gating tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("does not create a purchase when purchases_returns_tracking is disabled", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, entitlementsStub({ purchases_returns_tracking: false }), stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
    ai.enqueue(
      "receipt_extraction_v1",
      fakeExtraction({
        merchantName: "Gated Store",
        orderNumber: "GATE-1",
        purchaseDate: { iso_date: "2026-09-01", approximate_text: null },
        totalAmountMinorUnits: 5_000,
        currency: "USD",
        lineItems: [],
        returnDeadline: null,
        confidenceNotes: "n/a",
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Gated Store receipt", bodyText: "Total: $50.00" });

    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    expect(purchases).toHaveLength(0);
    // domain_classifier_v1 + receipt_extraction_v1 would both be called if the gate didn't work; confirm the extractor itself was never reached.
    expect(ai.calls).not.toContain("receipt_extraction_v1");
  });

  it("still creates a purchase when purchases_returns_tracking is enabled", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, entitlementsStub({ purchases_returns_tracking: true }), stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
    ai.enqueue(
      "receipt_extraction_v1",
      fakeExtraction({
        merchantName: "Allowed Store",
        orderNumber: "ALLOW-1",
        purchaseDate: { iso_date: "2026-09-01", approximate_text: null },
        totalAmountMinorUnits: 6_000,
        currency: "USD",
        lineItems: [],
        returnDeadline: null,
        confidenceNotes: "n/a",
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Allowed Store receipt", bodyText: "Total: $60.00" });

    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    expect(purchases).toHaveLength(1);
  });

  it("does not create a bill when subscriptions_bills_tracking is disabled", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, entitlementsStub({ subscriptions_bills_tracking: false }), stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({
        billerName: "Gated Utility",
        amountDueMinorUnits: 7_000,
        currency: "USD",
        dueDate: { iso_date: "2026-09-20", approximate_text: null },
        autopayMentioned: false,
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Gated Utility bill", bodyText: "Amount due: $70.00" });

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills).toHaveLength(0);
    expect(ai.calls).not.toContain("bill_extraction_v1");
  });

  it("does not gate shipments, which have no dedicated capability key", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(
      db,
      ai,
      stubNotifications,
      stubStorage,
      stubMalwareScanner,
      entitlementsStub({ purchases_returns_tracking: false, subscriptions_bills_tracking: false }),
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
    );

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["shipment"] }));
    ai.enqueue(
      "shipment_extraction_v1",
      fakeExtraction({ carrier: "UPS", trackingNumber: "1Z-GATE-TEST", status: "in_transit", estimatedDelivery: null, orderNumber: null, confidenceNotes: "n/a" }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Shipping update", bodyText: "Your package is on its way." });

    const shipments = await db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, ownerUserId));
    expect(shipments).toHaveLength(1);
  });
});
