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

/** Phase 2 §52.2 "store credits" — real integration test, same shape as ingestion.dedup.test.ts. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const allowingEntitlements = { getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService extractStoreCredit", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `store-credit-test-${ownerUserId}@example.com`, displayName: "Store Credit Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping extractStoreCredit tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("creates a real store_credits row from a real email, resolving the merchant", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["store_credit"] }));
    ai.enqueue(
      "store_credit_extraction_v1",
      fakeExtraction({
        merchantName: "Acme Outfitters",
        amountMinorUnits: 4_500,
        currency: "USD",
        expirationDate: { iso_date: "2027-01-01", approximate_text: null },
        confidenceNotes: "Clearly stated $45.00 credit.",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your Acme Outfitters store credit",
      bodyText: "We've issued a $45.00 store credit to your account, valid through January 2027.",
    });

    const credits = await db.select().from(schema.storeCredits).where(eq(schema.storeCredits.ownerUserId, ownerUserId));
    expect(credits).toHaveLength(1);
    expect(credits[0]?.amountMinorUnits).toBe(4_500);
    expect(credits[0]?.redeemed).toBe(false);

    const merchant = credits[0]?.merchantId ? await db.select().from(schema.merchants).where(eq(schema.merchants.id, credits[0].merchantId)).limit(1) : [];
    expect(merchant[0]?.displayName).toBe("Acme Outfitters");
  });

  it("does not create a store credit when purchases_returns_tracking is disabled", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const gatedEntitlements = { getCapability: async (_u: string, key: string) => key !== "purchases_returns_tracking" } as unknown as EntitlementsService;
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, gatedEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["store_credit"] }));
    ai.enqueue("store_credit_extraction_v1", fakeExtraction({ merchantName: "Gated Store", amountMinorUnits: 1_000, currency: "USD", expirationDate: null, confidenceNotes: "n/a" }));
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Gated store credit", bodyText: "Credit issued." });

    // Scoped to this test's own distinguishing amount, not a bare count for ownerUserId — the previous
    // test in this file already left one real row for the same shared test user.
    const credits = await db.select().from(schema.storeCredits).where(and(eq(schema.storeCredits.ownerUserId, ownerUserId), eq(schema.storeCredits.amountMinorUnits, 1_000)));
    expect(credits).toHaveLength(0);
    expect(ai.calls).not.toContain("store_credit_extraction_v1");
  });

  it("does not duplicate a store credit when a second email restates the same balance (findExistingStoreCredit dedup)", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const expirationDate = { iso_date: "2027-06-01", approximate_text: null };
    for (let i = 0; i < 2; i++) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["store_credit"] }));
      ai.enqueue(
        "store_credit_extraction_v1",
        fakeExtraction({
          merchantName: "Dedup Outfitters",
          amountMinorUnits: 7_200,
          currency: "USD",
          expirationDate,
          confidenceNotes: "Clearly stated $72.00 credit.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: i === 0 ? "Your Dedup Outfitters store credit" : "Reminder: your Dedup Outfitters store credit",
        bodyText: "We've issued a $72.00 store credit to your account, valid through June 2027.",
      });
    }

    const credits = await db.select().from(schema.storeCredits).where(and(eq(schema.storeCredits.ownerUserId, ownerUserId), eq(schema.storeCredits.amountMinorUnits, 7_200)));
    expect(credits).toHaveLength(1); // second email updated the existing row rather than creating a sibling
  });

  it("does not merge two genuinely different store credits from the same merchant that happen to share only the amount (different expiration dates)", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const expirationDates = [
      { iso_date: "2027-08-01", approximate_text: null },
      { iso_date: "2028-02-01", approximate_text: null },
    ];
    for (const expirationDate of expirationDates) {
      ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["store_credit"] }));
      ai.enqueue(
        "store_credit_extraction_v1",
        fakeExtraction({
          merchantName: "Ambiguous Outfitters",
          amountMinorUnits: 3_300,
          currency: "USD",
          expirationDate,
          confidenceNotes: "Clearly stated $33.00 credit.",
        }),
      );
      await ingestion.ingestManualText({
        ownerUserId,
        householdId: null,
        subject: `Your Ambiguous Outfitters store credit, expires ${expirationDate.iso_date}`,
        bodyText: `We've issued a $33.00 store credit to your account, valid through ${expirationDate.iso_date}.`,
      });
    }

    // Same merchant, same amount, but a materially different expiration date — a real store could plausibly
    // issue two separate $33 credits at different times. findExistingStoreCredit requires an EXACT
    // expiration-date match (no tolerance window, unlike findExistingBill), so these must stay two rows.
    const credits = await db.select().from(schema.storeCredits).where(and(eq(schema.storeCredits.ownerUserId, ownerUserId), eq(schema.storeCredits.amountMinorUnits, 3_300)));
    expect(credits).toHaveLength(2);
  });
});
