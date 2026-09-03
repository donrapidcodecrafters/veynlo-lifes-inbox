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
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

/** Minimal `gmail_v1.Schema$Message` — exactly the shape `parseGmailMessage` (gmail-message-parser.ts)
 * reads: headers for from/subject/date, a plain-text body part, and `snippet`. */
function fakeGmailMessage(opts: { id: string; from: string; subject: string; bodyText: string }) {
  return {
    id: opts.id,
    snippet: opts.bodyText.slice(0, 100),
    payload: {
      headers: [
        { name: "From", value: opts.from },
        { name: "Subject", value: opts.subject },
        { name: "Date", value: new Date().toUTCString() },
      ],
      mimeType: "text/plain",
      body: { data: Buffer.from(opts.bodyText, "utf8").toString("base64url") },
    },
  } as unknown as Parameters<IngestionService["ingestGmailMessage"]>[0]["message"];
}

/**
 * PRIV-001 "per-source AI-processing toggle" and "exclude specific senders from a connection" — both are
 * checked at the very front of `IngestionService.classifyAndExtract`, before any AI call, for
 * connection-sourced email (Gmail/Outlook). Real integration tests against real Postgres, same shape as
 * ingestion.dedup.test.ts: no mocking of the gate itself, just seeding the DB rows the gate reads and
 * proving the AI extractor genuinely never runs when it should be blocked (via FakeModelProvider.calls),
 * and genuinely does run — and files real data — when it shouldn't be.
 */
describe("IngestionService — per-connection AI toggle and sender exclusion", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `conn-privacy-${ownerUserId}@example.com`, displayName: "Connection Privacy Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping connection-privacy ingestion tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  async function makeConnection(overrides: Partial<typeof schema.connections.$inferInsert> = {}): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider: "gmail",
      feasibilityClass: "direct_api",
      ...overrides,
    });
    return connectionId;
  }

  function makeIngestion(ai: FakeModelProvider): IngestionService {
    return new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);
  }

  it("account-wide AI processing ON, connection override OFF: the AI extractor never runs, and nothing is filed", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    const connectionId = await makeConnection({ aiProcessingEnabled: false });
    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Override Test Co", amountDueMinorUnits: 1234, currency: "USD", dueDate: { iso_date: "2026-10-01", approximate_text: null }, autopayMentioned: false }),
    );

    await makeIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `override-off-${connectionId}`, from: "billing@overridetest.example", subject: "Payment due reminder", bodyText: "Payment due: $12.34." }),
    });

    expect(ai.calls).toHaveLength(0); // the per-connection override, not the (still-ON) global setting, must be what's checked
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 1234)).toBe(false);
    const [event] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, `gmail:override-off-${connectionId}`));
    expect(event?.processingState).toBe("filed");
  });

  it("account-wide AI processing OFF, connection override ON: the AI extractor DOES run and files real data", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ aiProcessingEnabled: false }).where(eq(schema.users.id, ownerUserId));
    const connectionId = await makeConnection({ aiProcessingEnabled: true });
    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Override Test Co Two", amountDueMinorUnits: 5678, currency: "USD", dueDate: { iso_date: "2026-10-05", approximate_text: null }, autopayMentioned: false }),
    );

    await makeIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `override-on-${connectionId}`, from: "billing@overridetest2.example", subject: "Payment due reminder", bodyText: "Payment due: $56.78." }),
    });

    expect(ai.calls.length).toBeGreaterThan(0); // the override, not the (OFF) global default, gates this
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 5678)).toBe(true);

    // Reset the global toggle back to its default for any later test in this file/process.
    await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
  });

  it("connection override null (inherit): follows whatever the global setting currently is", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    const connectionId = await makeConnection({ aiProcessingEnabled: null });
    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Inherit Test Co", amountDueMinorUnits: 999, currency: "USD", dueDate: { iso_date: "2026-10-10", approximate_text: null }, autopayMentioned: false }),
    );

    await makeIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `inherit-${connectionId}`, from: "billing@inherittest.example", subject: "Payment due reminder", bodyText: "Payment due: $9.99." }),
    });

    expect(ai.calls.length).toBeGreaterThan(0);
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 999)).toBe(true);
  });

  it("a sender domain excluded on this connection is filed unprocessed even with AI processing fully enabled", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    const connectionId = await makeConnection({ aiProcessingEnabled: true });
    await db.insert(schema.connectionExclusions).values({ id: generateId("connectionExclusion"), connectionId, excludedSenderDomain: "excluded-sender.example" });

    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Excluded Co", amountDueMinorUnits: 4321, currency: "USD", dueDate: { iso_date: "2026-10-15", approximate_text: null }, autopayMentioned: false }),
    );

    await makeIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: fakeGmailMessage({ id: `excluded-${connectionId}`, from: "billing@excluded-sender.example", subject: "Payment due reminder", bodyText: "Payment due: $43.21." }),
    });

    expect(ai.calls).toHaveLength(0);
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 4321)).toBe(false);
    const [event] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, `gmail:excluded-${connectionId}`));
    expect(event?.processingState).toBe("filed");
  });

  it("the SAME sender is NOT excluded on a different connection — exclusion is scoped per-connection, not account-wide", async () => {
    if (!dbAvailable) return;
    await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    const excludedConnectionId = await makeConnection({ aiProcessingEnabled: true });
    await db.insert(schema.connectionExclusions).values({ id: generateId("connectionExclusion"), connectionId: excludedConnectionId, excludedSenderDomain: "cross-scope.example" });
    const otherConnectionId = await makeConnection({ aiProcessingEnabled: true });

    const ai = new FakeModelProvider();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["bill"] }));
    ai.enqueue(
      "bill_extraction_v1",
      fakeExtraction({ billerName: "Cross Scope Co", amountDueMinorUnits: 2222, currency: "USD", dueDate: { iso_date: "2026-10-20", approximate_text: null }, autopayMentioned: false }),
    );

    await makeIngestion(ai).ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId: otherConnectionId,
      message: fakeGmailMessage({ id: `cross-scope-${otherConnectionId}`, from: "billing@cross-scope.example", subject: "Payment due reminder", bodyText: "Payment due: $22.22." }),
    });

    expect(ai.calls.length).toBeGreaterThan(0); // NOT blocked — the exclusion belongs to a different connection
    const bills = await db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, ownerUserId));
    expect(bills.some((b) => b.amountDueMinorUnits === 2222)).toBe(true);
  });
});
