import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import { RiskPolicyService, DOMAIN_WILDCARD_FIELD } from "../intelligence/risk-policy.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * §AI-002 "Confidence and risk policy" — proves `RiskPolicyService` is genuinely wired into
 * `IngestionService`'s `confidenceToBand` call sites, not just built and left unused. Real integration
 * test against a real Postgres (same convention as ingestion.dedup.test.ts): a domain-specific policy row
 * changes the resulting `confidenceBand` for that domain's extractor while leaving an unconfigured domain
 * (and the exact same domain when no policy row exists at all) on the fixed global default — i.e. this is
 * additive, not a behavior change for anything not explicitly configured.
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

describe("IngestionService §AI-002 risk-policy wiring", () => {
  let db: Database;
  let riskPolicy: RiskPolicyService;
  let ownerUserId: string;
  let dbAvailable = true;
  const insertedPolicyIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `riskpolicy-test-${ownerUserId}@example.com`, displayName: "Risk Policy Test" });
      riskPolicy = new RiskPolicyService(db);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService risk-policy tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      for (const id of insertedPolicyIds) {
        await db.delete(schema.riskPolicies).where(eq(schema.riskPolicies.id, id));
      }
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("applies a stricter domain-specific policy to 'bill', banding a confidence score that would be 'high' under the global default as 'needs_review' instead", async () => {
    if (!dbAvailable) return;
    const policyId = generateId("riskPolicy");
    insertedPolicyIds.push(policyId);
    // Global default is {reviewThreshold: 0.55, highThreshold: 0.85} — a 0.92 score would band "high" there.
    // This policy demands 0.99 before "high", so the SAME 0.92 score must land "needs_review" instead.
    await db.insert(schema.riskPolicies).values({ id: policyId, domain: "bill", field: DOMAIN_WILDCARD_FIELD, reviewThreshold: 0.9, autoAcceptThreshold: 0.99, policyVersion: "v1" });

    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(
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
      riskPolicy,
      undefined,
    );

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction(
        { billerName: "Strict Policy Electric Co", amountDueMinorUnits: 9_999, currency: "USD", dueDate: { iso_date: "2026-10-01", approximate_text: null }, autopayMentioned: false },
        0.92,
      ),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Strict Policy Electric Co bill", bodyText: "Amount due: $99.99." });

    const bills = await db.select().from(schema.bills).where(and(eq(schema.bills.ownerUserId, ownerUserId), eq(schema.bills.amountDueMinorUnits, 9_999)));
    expect(bills).toHaveLength(1);
    expect(bills[0]?.confidenceBand).toBe("needs_review");
  });

  it("an unconfigured domain (no risk_policies row at all) keeps banding against the exact same global default as before this existed", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(
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
      riskPolicy,
      undefined,
    );

    // 0.92 >= the global default's 0.85 highThreshold -> "high", for a domain ("warranty") with no
    // risk_policies row configured anywhere.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["warranty"] }));
    ai.enqueue(
      "warranty_extraction_v1",
      fakeExtraction(
        { productLabel: "Unconfigured Domain Test Blender", warrantyExpirationDate: { iso_date: "2027-01-01", approximate_text: null }, warrantyLengthMonths: 12, registrationConfirmed: true, confidenceNotes: "Clear warranty confirmation." },
        0.92,
      ),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Warranty confirmation", bodyText: "Your Unconfigured Domain Test Blender warranty is registered." });

    const warranties = await db.select().from(schema.warranties).where(eq(schema.warranties.ownerUserId, ownerUserId));
    const matching = warranties.filter((w) => w.productLabel === "Unconfigured Domain Test Blender");
    expect(matching).toHaveLength(1);
    expect(matching[0]?.confidenceBand).toBe("high");
  });
});
