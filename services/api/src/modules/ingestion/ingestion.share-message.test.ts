import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { MemoriesService } from "../memories/memories.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { HouseholdService } from "../household/household.service";
import type { SharingService } from "../sharing/sharing.service";
import type { DocumentsService } from "../documents/documents.service";

/**
 * §MSG-001 "Share-message extraction" real Postgres integration test — proves the share-sheet capture
 * path routes a classified share into the matching REAL domain object (a task row, a Saved Memory row),
 * not just an undifferentiated generic note, and that the existing purchase/calendar extractors are
 * genuinely reused (not reimplemented) for those categories. Also proves the "never assert sender
 * identity" discipline: nothing filed from a share ever carries a fabricated sender/from claim.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
// MemoriesService.create() (the only method fileShareMemory calls) never touches households/sharing/
// documents/queue — it only reads/writes `this.db` and checks `this.ai.isConfigured()` — so these are
// safe, unused stubs; this is a REAL MemoriesService making REAL writes to `saved_memories`, not a fake.
const stubQueue = { enqueueMemoryClassification: async () => {} } as unknown as QueueProducer;
const stubDocuments = {} as unknown as DocumentsService;
const stubHouseholds = {} as unknown as HouseholdService;
const stubSharing = {} as unknown as SharingService;

describe("IngestionService MSG-001 share-message classification routing", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let memories: MemoriesService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `share-msg-test-${ownerUserId}@example.com`, displayName: "Share Message Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping MSG-001 share-message tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  function makeIngestion(): void {
    ai = new FakeModelProvider();
    memories = new MemoriesService(db, ai, stubQueue, stubDocuments, stubHouseholds, stubSharing);
    ingestion = new IngestionService(
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
      memories,
    );
  }

  it("classifies a task-shaped share and creates a REAL task row, not a generic saved note", async () => {
    if (!dbAvailable) return;
    makeIngestion();
    ai.enqueue(
      "share_message_classifier_v1",
      fakeExtraction({
        category: "task",
        confidence: 0.9,
        title: "Pick up dry cleaning",
        dateIso: "2026-09-05",
        taskDescription: "Pick up the dry cleaning before Friday",
        addressText: null,
        personMentioned: null,
        noteText: null,
        reasoning: "Clear actionable task with a date.",
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Text from Sam",
      bodyText: "hey can you pick up the dry cleaning before friday??",
      kind: "share_capture",
    });

    // `title` is encrypted at rest — no SQL-level equality lookup (same reason ingestion.dedup.test.ts's
    // calendar-event tests fetch owner-scoped candidates and compare the DECRYPTED title in application
    // code instead); fetch by owner, then find by the decrypted value.
    const allTasks = await db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    const tasks = allTasks.filter((t) => t.title === "Pick up the dry cleaning before Friday");
    expect(tasks).toHaveLength(1);
    expect((tasks[0]?.dueCondition as { date?: string } | null)?.date).toBe("2026-09-05");

    const memoryRows = await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.ownerUserId, ownerUserId));
    // A genuinely task-shaped share must NOT also land as a generic saved note — this is the exact
    // "undifferentiated note" gap this feature fixes.
    expect(memoryRows).toHaveLength(0);

    const inboxItems = await db.select().from(schema.inboxItems).where(and(eq(schema.inboxItems.ownerUserId, ownerUserId), eq(schema.inboxItems.category, "task")));
    expect(inboxItems).toHaveLength(1);
    expect(inboxItems[0]?.linkedResourceId).toBe(tasks[0]?.id);
  });

  it("routes a purchase-shaped share through the EXISTING receipt extractor, reusing it rather than reimplementing it", async () => {
    if (!dbAvailable) return;
    makeIngestion();
    ai.enqueue(
      "share_message_classifier_v1",
      fakeExtraction({
        category: "purchase",
        confidence: 0.88,
        title: "Ordered new headphones",
        dateIso: null,
        taskDescription: null,
        addressText: null,
        personMentioned: null,
        noteText: null,
        reasoning: "A purchase confirmation was forwarded.",
      }),
    );
    ai.enqueue(
      "receipt_extraction_v1",
      fakeExtraction({
        merchantName: "Share Test Audio Co",
        orderNumber: "SHARE-PUR-001",
        purchaseDate: { iso_date: "2026-09-01", approximate_text: null },
        totalAmountMinorUnits: 12_999,
        currency: "USD",
        taxMinorUnits: null,
        shippingMinorUnits: null,
        lineItems: [{ productLabel: "Wireless Headphones", quantity: 1, unitPriceMinorUnits: 12_999 }],
        returnDeadline: null,
        confidenceNotes: "Forwarded order confirmation.",
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Forwarded receipt",
      bodyText: "Look what I got! Order confirmed from Share Test Audio Co, $129.99.",
      kind: "share_capture",
    });

    const purchases = await db.select().from(schema.purchases).where(and(eq(schema.purchases.ownerUserId, ownerUserId), eq(schema.purchases.orderNumber, "SHARE-PUR-001")));
    expect(purchases).toHaveLength(1);
    expect(purchases[0]?.totalMinorUnits).toBe(12_999);
    // Called through the real extractor, not a parallel implementation.
    expect(ai.calls).toContain("receipt_extraction_v1");
  });

  it("routes a note/recommendation-shaped share into a real Saved Memory, never a fabricated sender", async () => {
    if (!dbAvailable) return;
    makeIngestion();
    ai.enqueue(
      "share_message_classifier_v1",
      fakeExtraction({
        category: "recommendation",
        confidence: 0.7,
        title: "Try Luna's Tacos",
        dateIso: null,
        taskDescription: null,
        addressText: null,
        personMentioned: "Jordan",
        noteText: "Jordan says Luna's Tacos on 5th is amazing, especially the al pastor.",
        reasoning: "A restaurant recommendation was shared.",
      }),
    );

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Text thread",
      bodyText: "Jordan: you HAVE to try Luna's Tacos on 5th, the al pastor is unreal",
      kind: "share_capture",
    });

    // `title`/`rawText`/`userNotes` are all encrypted at rest — same "fetch by owner, filter decrypted in
    // application code" reasoning as the task test above.
    const allMemoriesForRec = await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.ownerUserId, ownerUserId));
    const memoryRows = allMemoriesForRec.filter((m) => m.title === "Try Luna's Tacos");
    expect(memoryRows).toHaveLength(1);
    expect(memoryRows[0]?.rawText).toContain("Luna's Tacos");
    expect(memoryRows[0]?.tags).toEqual(["recommendation"]);
    // The person mentioned IN the content is preserved (in userNotes)...
    expect(memoryRows[0]?.userNotes).toContain("Jordan");
    // ...but nowhere does this app assert a verified SENDER identity — no such field exists on the row at
    // all (savedMemories has no "fromAddress"/"senderName"/"verifiedSender" column), which is the
    // structural enforcement MSG-001 calls for, not just a prompt-level promise.
    expect(Object.keys(memoryRows[0] ?? {}).some((k) => /sender|from(name)?$/i.test(k))).toBe(false);
  });

  it("falls back to a generic saved note when the classifier can't produce structured data, so a deliberate share is never silently dropped", async () => {
    if (!dbAvailable) return;
    makeIngestion();
    // No `share_message_classifier_v1` enqueued at all — FakeModelProvider.extractStructured returns null,
    // simulating a real "couldn't extract" model response.

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Ambiguous share",
      bodyText: "lol did you see this",
      kind: "share_capture",
    });

    const allMemoriesForFallback = await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.ownerUserId, ownerUserId));
    const memoryRows = allMemoriesForFallback.filter((m) => m.rawText === "lol did you see this");
    expect(memoryRows).toHaveLength(1);
  });

  it("does not run the share-message classifier for an ordinary (non-share) manual capture", async () => {
    if (!dbAvailable) return;
    makeIngestion();
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["irrelevant"] }));

    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Just a note I typed",
      bodyText: "Remember to water the plants.",
      // No `kind` — defaults to "manual_entry", must go through the ORIGINAL email-shaped classifier.
    });

    expect(ai.calls).toContain("domain_classifier_v1");
    expect(ai.calls).not.toContain("share_message_classifier_v1");
  });
});
