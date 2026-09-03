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

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const allowingEntitlements = { getCapability: async () => true } as unknown as EntitlementsService;

/**
 * UTIL-001 "Track electric, gas, water, sewer, trash, internet, mobile, cable/satellite and security
 * bills ... equipment return obligations ... from source messages where available" — IngestionService.
 * extractBill now also categorizes the biller (biller-category.ts's heuristic) and, explicit-only, captures
 * an equipment-return deadline/instructions when the source email literally states one. Real end-to-end
 * integration test, same shape as ingestion.warranty.test.ts: a FakeModelProvider stands in for the real AI
 * extractor (no ANTHROPIC_API_KEY needed), everything downstream runs for real against dev Postgres.
 */
describe("IngestionService extractBill — UTIL-001 category + equipment-return", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `bill-equip-test-${ownerUserId}@example.com`, displayName: "Bill Equipment Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping extractBill equipment-return tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("categorizes a recognizable utility biller and captures an explicitly-stated equipment-return deadline", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({
        billerName: "Regional Cable Co",
        amountDueMinorUnits: 8_999,
        currency: "USD",
        dueDate: { iso_date: "2026-10-01", approximate_text: null },
        autopayMentioned: false,
        accountLabel: "Acct #445566",
        equipmentReturnDeadline: { iso_date: "2026-10-15", approximate_text: null },
        equipmentReturnInstructions: "Return your cable box and remote to any Regional Cable Co store within 14 days of cancellation or a $150 unreturned-equipment fee applies.",
        confidenceNotes: "Final bill after cancellation, explicit equipment-return deadline stated.",
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your final Regional Cable Co bill",
      bodyText: "Your service has been cancelled. Final balance: $89.99. Return your cable box and remote within 14 days.",
    });

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills).toHaveLength(1);
    const bill = bills[0]!;
    expect(bill.billerCategory).toBe("cable");
    expect(bill.equipmentReturnDeadlineSort).not.toBeNull();
    expect(bill.equipmentReturnDeadline?.date).toBe("2026-10-15");
    expect(bill.equipmentReturnInstructions).toContain("Return your cable box and remote");
  });

  it("never invents an equipment-return deadline when the email doesn't mention one", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({
        billerName: "City Electric Utility",
        amountDueMinorUnits: 12_000,
        currency: "USD",
        dueDate: { iso_date: "2026-09-15", approximate_text: null },
        autopayMentioned: true,
        accountLabel: null,
        equipmentReturnDeadline: null,
        equipmentReturnInstructions: null,
        confidenceNotes: "Ordinary monthly bill, no equipment mentioned.",
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your City Electric Utility bill is ready",
      bodyText: "Your September electric bill of $120.00 is due September 15th. Autopay is enrolled.",
    });

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    const bill = bills.find((b) => b.billerLabel === "City Electric Utility");
    expect(bill).toBeDefined();
    expect(bill!.billerCategory).toBe("electric");
    expect(bill!.equipmentReturnDeadlineSort).toBeNull();
    expect(bill!.equipmentReturnInstructions).toBeNull();
  });
});
