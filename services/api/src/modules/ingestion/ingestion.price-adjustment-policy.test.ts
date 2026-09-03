import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
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
 * RET-004 "Policy engine ... deadline calculator" — real-DB proof that extractReceipt's price-adjustment
 * window check now actually reads a per-merchant policy (services/api/src/modules/commerce/price-adjustment-policy.ts)
 * instead of the old flat 30-day-for-everyone heuristic (see docs/PHASE2_PENDING_CREDENTIALS.md's RET-004
 * entry and ingestion.dedup.test.ts's own 29/31-day boundary test, which proves the flat-default FALLBACK
 * path still works unchanged for a merchant with no specific policy — that's the "no regression" half;
 * this file is the "actually merchant-specific now" half).
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

describe("IngestionService RET-004 per-merchant price-adjustment policy", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `padj-policy-test-${ownerUserId}@example.com`, displayName: "Price Adjustment Policy Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService RET-004 policy tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  async function buyTwice(merchantName: string, product: string, order1: string, date1: string, price1: number, order2: string, date2: string, price2: number) {
    for (const p of [
      { orderNumber: order1, isoDate: date1, unitPriceMinorUnits: price1 },
      { orderNumber: order2, isoDate: date2, unitPriceMinorUnits: price2 },
    ]) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
      ai.enqueue(
        "receipt_extraction_v1",
        fakeExtraction({
          merchantName,
          orderNumber: p.orderNumber,
          purchaseDate: { iso_date: p.isoDate, approximate_text: null },
          totalAmountMinorUnits: p.unitPriceMinorUnits,
          currency: "USD",
          taxMinorUnits: null,
          shippingMinorUnits: null,
          lineItems: [{ productLabel: product, quantity: 1, unitPriceMinorUnits: p.unitPriceMinorUnits }],
          returnDeadline: null,
          confidenceNotes: "Clear receipt.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: `Your ${merchantName} order ${p.orderNumber}`,
        bodyText: `${product} x1, $${(p.unitPriceMinorUnits / 100).toFixed(2)}.`,
      });
    }
  }

  it("a merchant with a SHORTER-than-30-day policy does NOT fire at a gap the flat 30-day default would have allowed", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // Merchant name is unique per test run (suffixed with ownerUserId) — findOrCreateMerchant matches by
    // EXACT display-name string with no scoping to this test, so a fixed name would silently attach to
    // a stale merchant row (with no fresh policy) left over from a PREVIOUS run of this same test, since
    // merchants are global reference data this suite never cleans up (same convention every other
    // real-DB test in this codebase already follows — see e.g. commerce.resale-and-price-adjustment.test.ts's
    // own merchant row).
    const merchantName = `Policy Test Short-Window Shop ${ownerUserId}`;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: merchantName });
    await db.insert(schema.merchantPriceAdjustmentPolicies).values({
      id: generateId("merchantPriceAdjustmentPolicy"),
      merchantId,
      ownerUserId: null,
      windowDays: 10,
      confidence: "commonly_known",
      sourceNote: "Test fixture: a real 10-day policy.",
    });

    // 20 days apart — inside the flat 30-day default, but OUTSIDE this merchant's real 10-day policy.
    await buyTwice(merchantName, "Policy Test Short-Window Widget", "PADJ-SHORT-001", "2026-01-01", 9_000, "PADJ-SHORT-002", "2026-01-21", 6_000);

    const lines = await db
      .select({ line: schema.purchaseLines })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    const matching = lines.filter((l) => l.line.productLabel === "Policy Test Short-Window Widget");
    expect(matching).toHaveLength(2);
    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, matching[0]!.line.id));
    expect(observations).toHaveLength(0);
  });

  it("a merchant with a LONGER-than-30-day policy DOES fire at a gap the flat 30-day default would have missed", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // Unique merchant name per run — see the previous test's comment for why.
    const merchantName = `Policy Test Long-Window Shop ${ownerUserId}`;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: merchantName });
    await db.insert(schema.merchantPriceAdjustmentPolicies).values({
      id: generateId("merchantPriceAdjustmentPolicy"),
      merchantId,
      ownerUserId: null,
      windowDays: 45,
      confidence: "commonly_known",
      sourceNote: "Test fixture: a real 45-day policy.",
    });

    // 35 days apart — outside the flat 30-day default, but INSIDE this merchant's real 45-day policy.
    await buyTwice(merchantName, "Policy Test Long-Window Widget", "PADJ-LONG-001", "2026-01-01", 9_000, "PADJ-LONG-002", "2026-02-05", 6_000);

    const lines = await db
      .select({ line: schema.purchaseLines })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    const matching = lines.filter((l) => l.line.productLabel === "Policy Test Long-Window Widget");
    expect(matching).toHaveLength(2);
    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, matching[0]!.line.id));
    expect(observations).toHaveLength(1);
    expect(observations[0]?.observedAmountMinorUnits).toBe(6_000);

    const inboxItems = await db
      .select()
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.category, "price_adjustment")));
    expect(inboxItems.filter((i) => i.linkedResourceId === matching[0]!.line.purchaseId)).toHaveLength(1);
  });

  it("a merchant with NO policy row still falls back to the flat 30-day default (fires at 29 days)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // Deliberately no merchantPriceAdjustmentPolicies row at all for this merchant. Unique name per run —
    // see the first test's comment for why (this merchant has no policy row either way, but a stale row
    // from a previous run could still carry one, defeating the "no policy" premise of this test).
    const merchantName = `Policy Test No-Policy Shop ${ownerUserId}`;
    await buyTwice(merchantName, "Policy Test No-Policy Widget", "PADJ-NONE-001", "2026-01-01", 9_000, "PADJ-NONE-002", "2026-01-30", 6_000);

    const lines = await db
      .select({ line: schema.purchaseLines })
      .from(schema.purchaseLines)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.purchaseLines.purchaseId))
      .where(eq(schema.purchases.ownerUserId, ownerUserId));
    const matching = lines.filter((l) => l.line.productLabel === "Policy Test No-Policy Widget");
    expect(matching).toHaveLength(2);
    const observations = await db.select().from(schema.priceObservations).where(eq(schema.priceObservations.subjectEntityId, matching[0]!.line.id));
    expect(observations).toHaveLength(1);
  });
});
