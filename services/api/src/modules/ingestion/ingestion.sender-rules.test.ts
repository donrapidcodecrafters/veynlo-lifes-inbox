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
 * MAIL-006 "User sender rules" — "Let users teach Life Inbox once... Always treat messages from this
 * sender as School / Bills / Ignore / Keep only attachments / Household shared." Real end-to-end
 * integration tests against dev Postgres, same shape as ingestion.bill-equipment-return.test.ts: a
 * FakeModelProvider stands in for the real AI extractor, everything else (sender-rule lookup, entitlement/
 * category gates, persistence) runs for real. `ingestManualText`'s default (non-"share_capture") kind
 * routes through the exact same `classifyAndExtract` a real Gmail/Outlook message does (see that method's
 * own doc comment), so it's a faithful, much simpler way to reach the sender-rule check than constructing a
 * full fake provider message.
 */
describe("IngestionService — MAIL-006 sender rules", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `sender-rules-test-${ownerUserId}@example.com`, displayName: "Sender Rules Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping MAIL-006 sender-rule tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.senderRules).where(eq(schema.senderRules.ownerUserId, ownerUserId));
      await db.delete(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
      await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it('an "ignore" sender rule files nothing at all — no inbox item, no domain record, source event marked filed', async () => {
    if (!dbAvailable) return;
    const senderDomain = "spammy-sender.example";
    await db.insert(schema.senderRules).values({ id: generateId("senderRule"), ownerUserId, senderDomain, action: "ignore" });

    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    // Deliberately never enqueued for domain_classifier_v1/bill_extraction_v1 — if "ignore" didn't
    // short-circuit before the classifier, this would still resolve (FakeModelProvider returns null for an
    // unqueued extractor, which classifyAndExtract already treats as "irrelevant"), so the real assertion
    // below is on `ai.calls` being empty, proving the classifier was never even invoked.
    const { sourceEventId } = await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Payment due for your Acme statement",
      bodyText: "Your payment of $50 is due.",
      fromAddress: `billing@${senderDomain}`,
    });

    expect(ai.calls).toHaveLength(0);

    const items = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.sourceEventId, sourceEventId));
    expect(items).toHaveLength(0);

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills).toHaveLength(0);

    const [sourceEvent] = await db.select({ processingState: schema.sourceEvents.processingState }).from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId)).limit(1);
    expect(sourceEvent?.processingState).toBe("filed");
  });

  it('an "always_bills" sender rule force-routes to the bill extractor without ever consulting the domain classifier', async () => {
    if (!dbAvailable) return;
    const senderDomain = "misclassified-biller.example";
    await db.insert(schema.senderRules).values({ id: generateId("senderRule"), ownerUserId, senderDomain, action: "always_bills" });

    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
    // No domain_classifier_v1 enqueued at all — always_bills must never call it. Only the bill extractor's
    // own field-extraction call is queued.
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({
        billerName: "Misclassified Biller Co",
        amountDueMinorUnits: 4_200,
        currency: "USD",
        dueDate: { iso_date: "2026-11-01", approximate_text: null },
        autopayMentioned: false,
        accountLabel: "Acct #9911",
        equipmentReturnDeadline: { iso_date: null, approximate_text: null },
        equipmentReturnInstructions: null,
        confidenceNotes: "Forced via sender rule, not the classifier.",
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your order confirmation from Misclassified Biller Co", // deliberately receipt-shaped subject —
      // if the classifier ran on this text it would very plausibly say "receipt", not "bill"; forcing
      // always_bills must win regardless of what the (never-called) classifier would have guessed.
      bodyText: "This is actually a monthly bill, but the subject line looks like a receipt.",
      fromAddress: `statements@${senderDomain}`,
    });

    expect(ai.calls).not.toContain("domain_classifier_v1");
    expect(ai.calls).toContain("bill_extraction_v1");

    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills).toHaveLength(1);
    expect(bills[0]!.billerLabel).toBe("Misclassified Biller Co");

    const items = await db.select().from(schema.inboxItems).where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.linkedResourceType, "bill")));
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('an "attachments_only" sender rule skips domain classification/extraction entirely (files nothing beyond attachments)', async () => {
    if (!dbAvailable) return;
    const senderDomain = "attachments-only-sender.example";
    await db.insert(schema.senderRules).values({ id: generateId("senderRule"), ownerUserId, senderDomain, action: "attachments_only" });

    const ai = new FakeModelProvider();
    const ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, allowingEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    const { sourceEventId } = await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your invoice is attached",
      bodyText: "See attached invoice.",
      fromAddress: `invoices@${senderDomain}`,
    });

    expect(ai.calls).toHaveLength(0);
    const items = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.sourceEventId, sourceEventId));
    expect(items).toHaveLength(0);
    const [sourceEvent] = await db.select({ processingState: schema.sourceEvents.processingState }).from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId)).limit(1);
    expect(sourceEvent?.processingState).toBe("filed");
  });
});
