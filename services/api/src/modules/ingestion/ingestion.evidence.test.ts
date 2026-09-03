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
 * Found while auditing this session's own work: `facts.evidenceIds` and the `evidence_refs` table it's
 * supposed to point at have existed since this schema was created, but every fact ever written passed
 * `evidenceIds: []` and nothing ever inserted an `evidence_refs` row — a provenance-tracked graph with no
 * actual provenance. Real DB integration test, same shape as ingestion.dedup.test.ts, proving a receipt's
 * purchase-line asset fact now carries a real, resolvable evidence citation end to end.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const allowingEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService knowledge-graph evidence citations", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `evidence-test-${ownerUserId}@example.com`, displayName: "Evidence Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping evidence citation tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("a receipt's purchase-line asset fact carries a resolvable evidence_refs citation", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["receipt"] }));
    ai.enqueue(
      "receipt_extraction_v1",
      fakeExtraction({
        merchantName: "Evidence Test Store",
        orderNumber: "EVID-001",
        purchaseDate: { iso_date: "2026-09-01", approximate_text: null },
        totalAmountMinorUnits: 4_999,
        currency: "USD",
        taxMinorUnits: null,
        shippingMinorUnits: null,
        lineItems: [{ productLabel: "Evidence Test Widget", quantity: 1, unitPriceMinorUnits: 4_999 }],
        returnDeadline: null,
        confidenceNotes: "Clear receipt.",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Evidence Test Store receipt",
      bodyText: "Thanks for your order! Evidence Test Widget x1, $49.99.",
    });

    const [entity] = await db
      .select()
      .from(schema.canonicalEntities)
      .where(eq(schema.canonicalEntities.ownerUserId, ownerUserId));
    expect(entity?.type).toBe("asset");
    expect(entity?.displayLabel).toBe("Evidence Test Widget");

    const facts = await db.select().from(schema.facts).where(eq(schema.facts.subjectEntityId, entity!.id));
    expect(facts).toHaveLength(1);
    expect(facts[0]?.evidenceIds).toHaveLength(1);

    const [evidenceRow] = await db.select().from(schema.evidenceRefs).where(eq(schema.evidenceRefs.id, facts[0]!.evidenceIds[0]!));
    expect(evidenceRow).toBeDefined();
    expect(evidenceRow?.locator).toBe("receipt_line_item");
    expect(evidenceRow?.excerpt).toContain("Evidence Test Widget");
    expect(evidenceRow?.sourceEventId).toBeTruthy();
  });
});
