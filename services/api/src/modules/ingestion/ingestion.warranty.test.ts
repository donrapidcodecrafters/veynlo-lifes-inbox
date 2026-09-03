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
 * §15 PUR-004/HOMEOS-008 warranty extraction — real integration test, same shape as
 * ingestion.dedup.test.ts/ingestion.store-credit.test.ts. Covers findExistingWarranty, which previously
 * did not exist at all: extractWarranty unconditionally inserted a new `warranties` row on every matching
 * email, so a resent registration confirmation or a follow-up email about the same warranty created a
 * sibling row instead of updating the existing one — the one dedup gap in this file's otherwise
 * consistent "more than one candidate -> treat as no match" discipline (see findExistingBill,
 * findExistingRecurringStream, findExistingStoreCredit, etc).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const allowingEntitlements = { getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService extractWarranty", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `warranty-test-${ownerUserId}@example.com`, displayName: "Warranty Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping extractWarranty tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("creates a real warranties row from a real email", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["warranty"] }));
    ai.enqueue(
      "warranty_extraction_v1",
      fakeExtraction({
        productLabel: "Acme Blender 3000",
        warrantyLengthMonths: 24,
        warrantyExpirationDate: { iso_date: "2028-05-01", approximate_text: null },
        registrationConfirmed: true,
        confidenceNotes: "Clearly stated 24-month warranty.",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Acme Blender 3000 warranty registration",
      bodyText: "Your 24-month warranty is now active, expiring May 2028.",
    });

    const warranties = await db.select().from(schema.warranties).where(eq(schema.warranties.ownerUserId, ownerUserId));
    expect(warranties).toHaveLength(1);
    expect(warranties[0]?.warrantyLengthMonths).toBe(24);
    expect(warranties[0]?.registrationConfirmed).toBe(true);
  });

  it("does not duplicate a warranty when a second email restates the same registration (findExistingWarranty dedup)", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const warrantyExpirationDate = { iso_date: "2029-03-01", approximate_text: null };
    for (let i = 0; i < 2; i++) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["warranty"] }));
      ai.enqueue(
        "warranty_extraction_v1",
        fakeExtraction({
          productLabel: "Dedup Dishwasher X200",
          warrantyLengthMonths: 36,
          warrantyExpirationDate,
          registrationConfirmed: true,
          confidenceNotes: "Clearly stated 36-month warranty.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your Dedup Dishwasher X200 warranty" : "Confirmed: your Dedup Dishwasher X200 warranty",
        bodyText: "Your 36-month warranty is now active, expiring March 2029.",
      });
    }

    const warranties = await db
      .select()
      .from(schema.warranties)
      .where(and(eq(schema.warranties.ownerUserId, ownerUserId), eq(schema.warranties.warrantyLengthMonths, 36)));
    expect(warranties).toHaveLength(1); // second email updated the existing row rather than creating a sibling
  });

  it("does not merge two genuinely different warranties that happen to share an expiration date", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const warrantyExpirationDate = { iso_date: "2030-01-01", approximate_text: null };
    const products = ["Ambiguous Toaster 9", "Ambiguous Kettle 9"];
    for (const productLabel of products) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["warranty"] }));
      ai.enqueue(
        "warranty_extraction_v1",
        fakeExtraction({
          productLabel,
          warrantyLengthMonths: 12,
          warrantyExpirationDate,
          registrationConfirmed: false,
          confidenceNotes: "Clearly stated 12-month warranty.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: `Your ${productLabel} warranty`,
        bodyText: "Your 12-month warranty is now active, expiring January 2030.",
      });
    }

    // Two distinct products bought/registered around the same time, coincidentally sharing an expiration
    // date — correctly NOT merged despite the identical date, since productLabel differs.
    const warranties = await db
      .select()
      .from(schema.warranties)
      .where(and(eq(schema.warranties.ownerUserId, ownerUserId), eq(schema.warranties.warrantyLengthMonths, 12)));
    expect(warranties).toHaveLength(2);
  });

  it("does not create a warranty when the email states no product label", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["warranty"] }));
    ai.enqueue(
      "warranty_extraction_v1",
      fakeExtraction({ productLabel: null, warrantyLengthMonths: null, warrantyExpirationDate: null, registrationConfirmed: null, confidenceNotes: "Nothing clearly stated." }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Warranty info", bodyText: "Vague warranty mention with no specifics." });

    const warranties = await db.select().from(schema.warranties).where(eq(schema.warranties.ownerUserId, ownerUserId));
    expect(warranties.filter((w) => w.warrantyLengthMonths === null && w.registrationConfirmed === null)).toHaveLength(0);
  });
});
