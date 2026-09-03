import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { PreferencesService } from "../preferences/preferences.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { IdentityService } from "../identity/identity.service";

/**
 * PERS-003 "Category preferences" — "Disabling a category pauses future processing where feasible and
 * explains retained existing data." This is the highest-risk piece of PERS-003 to get wrong: the two
 * failure modes are (a) disabling a category silently doing nothing (new items keep getting filed) or
 * (b) disabling a category destroying/hiding data that was already saved. Both are asserted here against
 * a REAL Postgres-backed PreferencesService (not a stub) — the actual `isCategoryEnabled` read path
 * IngestionService.classifyAndExtract calls in production — with a real pre-existing purchase row
 * inserted before the toggle to prove the "existing data stays intact" half, not just the "no new
 * extraction" half.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const allowingEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;
const stubIdentity = {} as unknown as IdentityService;

function receiptExtraction(overrides: Record<string, unknown> = {}) {
  return fakeExtraction({
    merchantName: "Category Pref Store",
    orderNumber: `CATPREF-${generateId("purchase")}`,
    purchaseDate: { iso_date: "2026-09-01", approximate_text: null },
    totalAmountMinorUnits: 5_000,
    currency: "USD",
    lineItems: [],
    returnDeadline: null,
    confidenceNotes: "n/a",
    ...overrides,
  });
}

describe("IngestionService category-preference gating (PERS-003)", () => {
  let db: Database;
  let preferences: PreferencesService;
  let ownerUserId: string;
  let preExistingPurchaseId: string;
  let dbAvailable = true;

  // A fresh FakeModelProvider (and therefore a fresh IngestionService) per test — FakeModelProvider's
  // queue is FIFO per extractorName and never auto-drains an item a gated-off call never consumed, so
  // sharing one instance across tests would let an earlier test's un-consumed queued extraction leak into
  // a later test's assertions. Real db/preferences/ownerUserId stay shared so the disable -> re-enable
  // sequence is a genuine sequence against the same stored row, not independent fixtures.
  function buildIngestion(): { ingestion: IngestionService; ai: FakeModelProvider } {
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, preferences);
    return { ingestion, ai };
  }

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    preferences = new PreferencesService(db, stubIdentity);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `catpref-test-${ownerUserId}@example.com`, displayName: "Category Preference Test" });

      // A purchase that already existed BEFORE the user ever touches the "purchases" category toggle —
      // this is the row that must survive completely untouched once the category is disabled.
      preExistingPurchaseId = generateId("purchase");
      await db.insert(schema.purchases).values({
        id: preExistingPurchaseId,
        ownerUserId,
        orderNumber: "PRE-EXISTING-ORDER",
        purchaseDate: { precision: "date", instantUtc: null, date: "2026-08-01", timezone: null, sourceText: null },
        totalMinorUnits: 12_345,
        totalCurrency: "USD",
        state: "confirmed",
        confidenceBand: "verified",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping category-preference tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.categoryPreferences).where(eq(schema.categoryPreferences.userId, ownerUserId));
      await db.delete(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("defaults to enabled with no stored preference row (no row = enabled, per PreferencesService.isCategoryEnabled)", async () => {
    if (!dbAvailable) return;
    const enabled = await preferences.isCategoryEnabled(ownerUserId, "purchases");
    expect(enabled).toBe(true);
    const list = await preferences.listCategoryPreferences(ownerUserId);
    const purchasesEntry = list.find((c) => c.domain === "purchases");
    expect(purchasesEntry?.enabled).toBe(true);
    expect(purchasesEntry?.disableExplanation).toMatch(/existing purchases stay saved/);
  });

  it("stops NEW purchase extraction once 'purchases' is disabled, while the pre-existing purchase remains untouched", async () => {
    if (!dbAvailable) return;

    await preferences.updateCategoryPreference(ownerUserId, { domain: "purchases", enabled: false });
    const disabled = await preferences.isCategoryEnabled(ownerUserId, "purchases");
    expect(disabled).toBe(false);

    const { ingestion, ai } = buildIngestion();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
    ai.enqueue("receipt_extraction_v1", receiptExtraction());
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "New receipt while category is off", bodyText: "Total: $50.00" });

    // The extractor itself was never reached — this is "paused future processing," not merely "processed
    // then discarded the result."
    expect(ai.calls).not.toContain("receipt_extraction_v1");

    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    // Still exactly the one pre-existing row — no new purchase was filed, and the old one wasn't touched.
    expect(purchases).toHaveLength(1);
    expect(purchases[0]!.id).toBe(preExistingPurchaseId);
    expect(purchases[0]!.orderNumber).toBe("PRE-EXISTING-ORDER");
    expect(purchases[0]!.totalMinorUnits).toBe(12_345);
  });

  it("also stops store_credit extraction (the other domain 'purchases' gates) while disabled", async () => {
    if (!dbAvailable) return;
    const stillDisabled = await preferences.isCategoryEnabled(ownerUserId, "purchases");
    expect(stillDisabled).toBe(false);

    const { ingestion, ai } = buildIngestion();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["store_credit"] }));
    ai.enqueue(
      "store_credit_extraction_v1",
      fakeExtraction({ merchantName: "Category Pref Store", amountMinorUnits: 2_000, currency: "USD", expirationDate: null, code: null, confidenceNotes: "n/a" }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Store credit while category is off", bodyText: "You have a $20 credit." });

    expect(ai.calls).not.toContain("store_credit_extraction_v1");
    const credits = await db.select().from(schema.storeCredits).where(eq(schema.storeCredits.ownerUserId, ownerUserId));
    expect(credits).toHaveLength(0);
  });

  it("does NOT gate shipment extraction — 'purchases' only covers receipt/store_credit, mirroring the entitlement gate's own scope", async () => {
    if (!dbAvailable) return;
    const { ingestion, ai } = buildIngestion();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["shipment"] }));
    ai.enqueue(
      "shipment_extraction_v1",
      fakeExtraction({ carrier: "UPS", trackingNumber: `1Z-CATPREF-${ownerUserId.slice(-6)}`, status: "in_transit", estimatedDelivery: null, orderNumber: null, confidenceNotes: "n/a" }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Shipping update while purchases category is off", bodyText: "Your package is on its way." });

    const shipments = await db.select().from(schema.shipments).where(eq(schema.shipments.ownerUserId, ownerUserId));
    expect(shipments).toHaveLength(1);
  });

  it("resumes NEW extraction once 'purchases' is re-enabled, without touching the row created while disabled", async () => {
    if (!dbAvailable) return;

    await preferences.updateCategoryPreference(ownerUserId, { domain: "purchases", enabled: true });
    const reEnabled = await preferences.isCategoryEnabled(ownerUserId, "purchases");
    expect(reEnabled).toBe(true);

    const { ingestion, ai } = buildIngestion();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
    ai.enqueue("receipt_extraction_v1", receiptExtraction({ orderNumber: "POST-RE-ENABLE-ORDER" }));
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "New receipt after re-enabling", bodyText: "Total: $50.00" });

    expect(ai.calls).toContain("receipt_extraction_v1");
    const purchases = await db.select().from(schema.purchases).where(eq(schema.purchases.ownerUserId, ownerUserId));
    expect(purchases).toHaveLength(2);
    expect(purchases.some((p) => p.id === preExistingPurchaseId && p.orderNumber === "PRE-EXISTING-ORDER")).toBe(true);
    expect(purchases.some((p) => p.orderNumber === "POST-RE-ENABLE-ORDER")).toBe(true);
  });

  it("leaves an unrelated category ('finance') enabled by default while 'purchases' state is independently toggled", async () => {
    if (!dbAvailable) return;
    const financeEnabled = await preferences.isCategoryEnabled(ownerUserId, "finance");
    expect(financeEnabled).toBe(true);

    const { ingestion, ai } = buildIngestion();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Category Pref Utility", amountDueMinorUnits: 4_000, currency: "USD", dueDate: { iso_date: "2026-09-20", approximate_text: null }, autopayMentioned: false }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Utility bill", bodyText: "Amount due: $40.00" });

    expect(ai.calls).toContain("bill_extraction_v1");
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills).toHaveLength(1);
  });
});
