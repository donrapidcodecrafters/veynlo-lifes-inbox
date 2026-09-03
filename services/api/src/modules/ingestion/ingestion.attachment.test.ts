import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { DocumentsService } from "../documents/documents.service";
import { SharingService } from "../sharing/sharing.service";
import { FakeModelProvider } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { HouseholdService } from "../household/household.service";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { GraphMessage } from "./outlook-message-parser";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const allowingEntitlements = { getCapability: async () => true, assertStorageQuota: async () => {} } as unknown as EntitlementsService;
const stubHouseholds = { delegatedHouseholdIds: async () => [], activeHouseholdIds: async () => [], isActiveMember: async () => false } as unknown as HouseholdService;
const stubDocumentsAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;

/** Minimal in-memory ObjectStorage — a real Postgres row is what this test actually cares about; the blob
 * store itself just needs to round-trip bytes without touching real S3/GCS, same stance as
 * documents.delete.test.ts's identical stub. */
function inMemoryObjectStorage(): ObjectStorage {
  const blobs = new Map<string, Buffer>();
  return {
    putObject: async (key: string, buffer: Buffer) => {
      blobs.set(key, buffer);
    },
    getObject: async (key: string) => blobs.get(key) ?? Buffer.alloc(0),
    signedGetUrl: async (key: string) => `https://example.com/${key}`,
  } as unknown as ObjectStorage;
}

/**
 * MAIL-004 "Attachment intelligence" — "Attachments inherit message provenance and are scanned before
 * OCR/extraction." Until this pass, Gmail/Outlook attachments were never fetched or processed at all — this
 * is the real, scoped-down fix: an attachment on an ingested email becomes a real `documents` row, run
 * through the EXISTING malware-scan/upload pipeline (`DocumentsService.upload`, not a duplicate), and linked
 * back to the source email via `documents.sourceEventId`. `IngestionService.ingestOutlookMessage` is used
 * here (rather than Gmail) since `GraphMessage` is a plain flat object — no need to construct a nested MIME
 * payload just to exercise `attachments`, which OutlookAdapter/GmailAdapter both pre-fetch and pass through
 * identically before this ever reaches `IngestionService`.
 */
describe("IngestionService — MAIL-004 attachment intelligence", () => {
  let db: Database;
  let documents: DocumentsService;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    documents = new DocumentsService(db, inMemoryObjectStorage(), stubDocumentsAi, stubQueue, stubMalwareScanner, stubHouseholds, allowingEntitlements, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      connectionId = generateId("connection");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attachment-test-${ownerUserId}@example.com`, displayName: "Attachment Test" });
      // source_events.connectionId is a real FK — a fake connection row is needed for ingestOutlookMessage
      // to insert successfully, same as every other ingestion test that goes through the Gmail/Outlook
      // entry points rather than ingestManualText (which has no connectionId at all).
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "outlook",
        feasibilityClass: "direct_api",
        scopes: ["offline_access", "Mail.Read"],
        enabledCategories: ["purchases", "documents"],
        health: "healthy",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping MAIL-004 attachment tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      const ownedDocs = await db.select({ id: schema.documents.id }).from(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));
      if (ownedDocs.length > 0) {
        await db.delete(schema.documentVersions).where(inArray(schema.documentVersions.documentId, ownedDocs.map((d) => d.id)));
      }
      await db.delete(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));
      await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
      await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
      await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("fetches and stores an email attachment as a real documents row linked to the source email", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    ai.configured = false; // no domain classifier/extraction needed for this test — irrelevant body is fine
    const ingestion = new IngestionService(
      db,
      ai,
      stubNotifications,
      inMemoryObjectStorage(),
      stubMalwareScanner,
      allowingEntitlements,
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
      undefined, // memories
      documents,
    );

    const message: GraphMessage = {
      id: `msg_${generateId("sourceEvent")}`,
      subject: "Your invoice is attached",
      from: { emailAddress: { address: "billing@attachment-sender.example" } },
      toRecipients: [],
      receivedDateTime: new Date().toISOString(),
      bodyPreview: "Please see the attached invoice for your records.",
      body: { contentType: "text", content: "Please see the attached invoice for your records." },
      internetMessageHeaders: [],
      hasAttachments: true,
    };

    await ingestion.ingestOutlookMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message,
      attachments: [{ filename: "invoice.txt", mimeType: "text/plain", buffer: Buffer.from("Invoice #4821 — total due $120.00") }],
    });

    const [sourceEvent] = await db
      .select({ id: schema.sourceEvents.id })
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.ownerUserId, ownerUserId))
      .limit(1);
    expect(sourceEvent).toBeDefined();

    const docs = await db.select().from(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));
    expect(docs).toHaveLength(1);
    expect(docs[0]!.sourceEventId).toBe(sourceEvent!.id);
    expect(docs[0]!.title).toBe("invoice.txt");
    expect(docs[0]!.documentType).toBe("other");

    const versions = await db.select().from(schema.documentVersions).where(eq(schema.documentVersions.documentId, docs[0]!.id));
    expect(versions).toHaveLength(1);
    expect(versions[0]!.mimeType).toBe("text/plain");
    expect(versions[0]!.sizeBytes).toBe(Buffer.from("Invoice #4821 — total due $120.00").length);
  });

  it('an "ignore" sender rule skips attachment processing entirely — no document is created', async () => {
    if (!dbAvailable) return;
    const senderDomain = "ignored-with-attachment.example";
    await db.insert(schema.senderRules).values({ id: generateId("senderRule"), ownerUserId, senderDomain, action: "ignore" });

    const ai = new FakeModelProvider();
    ai.configured = false;
    const ingestion = new IngestionService(
      db,
      ai,
      stubNotifications,
      inMemoryObjectStorage(),
      stubMalwareScanner,
      allowingEntitlements,
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
      undefined,
      documents,
    );

    const message: GraphMessage = {
      id: `msg_${generateId("sourceEvent")}`,
      subject: "Your invoice is attached",
      from: { emailAddress: { address: `billing@${senderDomain}` } },
      toRecipients: [],
      receivedDateTime: new Date().toISOString(),
      bodyPreview: "Please see the attached invoice.",
      body: { contentType: "text", content: "Please see the attached invoice." },
      internetMessageHeaders: [],
      hasAttachments: true,
    };

    const docsBefore = await db.select().from(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));

    await ingestion.ingestOutlookMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message,
      attachments: [{ filename: "should-not-be-stored.txt", mimeType: "text/plain", buffer: Buffer.from("irrelevant") }],
    });

    const docsAfter = await db.select().from(schema.documents).where(eq(schema.documents.ownerUserId, ownerUserId));
    expect(docsAfter.length).toBe(docsBefore.length);
    await db.delete(schema.senderRules).where(eq(schema.senderRules.ownerUserId, ownerUserId));
  });
});
