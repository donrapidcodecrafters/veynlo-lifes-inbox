import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import { FakeVoiceTranscriber } from "../speech/fake-voice-transcriber";
import type { VoiceTranscriptionJobData } from "../../queue/queue-names";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * §52.1 "voice note" transcription — real Postgres integration test proving a captured voice note
 * eventually gets a real transcript, and that the transcript flows into the EXACT SAME
 * `classifyAndExtract` domain-classification/extraction pipeline manual-text capture already uses (not a
 * parallel, weaker path). The transcription MODEL call itself is stubbed via `FakeVoiceTranscriber` —
 * mirroring this codebase's established `FakeModelProvider` pattern for the Anthropic extraction model —
 * while every downstream step (source-event persistence, the transcript column, domain classification,
 * calendar-event extraction, inbox filing) is real. A real audio fixture would only exercise
 * `WhisperVoiceTranscriptionService`'s ffmpeg-decode-then-infer plumbing, which is orthogonal to (and far
 * slower than) the actual thing worth locking down here: that a transcript, once produced, reaches
 * ingestion's real pipeline rather than a parallel one.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const allowingEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

/** Minimal in-memory ObjectStorage — real put/get round-trip (processVoiceTranscription re-fetches the
 * blob by key exactly like the real worker does), no S3 dependency needed for this test. */
class InMemoryObjectStorage implements ObjectStorage {
  private readonly blobs = new Map<string, Buffer>();
  async putObject(key: string, body: Buffer): Promise<void> {
    this.blobs.set(key, body);
  }
  async getObject(key: string): Promise<Buffer> {
    const blob = this.blobs.get(key);
    if (!blob) throw new Error(`No such object: ${key}`);
    return blob;
  }
  async signedGetUrl(key: string): Promise<string> {
    return `https://example.invalid/${key}`;
  }
  async deleteObject(key: string): Promise<void> {
    this.blobs.delete(key);
  }
}

/** Records enqueued transcription jobs instead of touching real Redis/BullMQ — the test invokes
 * `processVoiceTranscription` directly with the recorded job data, simulating the background worker
 * picking the job up, same "call the worker method directly" approach this codebase's tests already use
 * for document OCR-shaped background work. */
class RecordingQueueProducer {
  readonly voiceTranscriptionJobs: VoiceTranscriptionJobData[] = [];
  async enqueueVoiceTranscription(data: VoiceTranscriptionJobData): Promise<void> {
    this.voiceTranscriptionJobs.push(data);
  }
}

describe("IngestionService voice note transcription", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `voice-note-test-${ownerUserId}@example.com`, displayName: "Voice Note Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping voice-note transcription tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  function buildIngestion(storage: ObjectStorage, ai: FakeModelProvider, queue: RecordingQueueProducer, transcriber: FakeVoiceTranscriber) {
    return new IngestionService(
      db,
      ai,
      stubNotifications,
      storage,
      stubMalwareScanner,
      allowingEntitlements,
      stubAutomation,
      stubConflicts,
      stubTrips,
      stubPreferences,
      undefined, // memories
      undefined, // documents
      undefined, // riskPolicy
      undefined, // featureFlags
      undefined, // searchIndex
      queue as unknown as QueueProducer,
      transcriber,
    );
  }

  it("a real transcript flows into the exact same classifyAndExtract pipeline manual-text capture uses", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const storage = new InMemoryObjectStorage();
    const queue = new RecordingQueueProducer();
    const transcriber = new FakeVoiceTranscriber();
    const ingestion = buildIngestion(storage, ai, queue, transcriber);

    const { sourceEventId } = await ingestion.ingestVoiceNote({
      ownerUserId,
      householdId: null,
      buffer: Buffer.from("fake m4a audio bytes"),
      mimeType: "audio/m4a",
    });

    // Capture is synchronous and immediate: the recording is already stored and playable, and pending
    // transcription work is reflected honestly rather than marked "filed" (done) prematurely.
    const [afterCapture] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId));
    expect(afterCapture?.processingState).toBe("understanding");
    expect(afterCapture?.transcript).toBeNull();
    expect(afterCapture?.kind).toBe("voice_note");

    const [captureInboxItem] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.sourceEventId, sourceEventId));
    expect(captureInboxItem?.category).toBe("voice_note");

    expect(queue.voiceTranscriptionJobs).toHaveLength(1);
    const job = queue.voiceTranscriptionJobs[0]!;
    expect(job.sourceEventId).toBe(sourceEventId);
    expect(job.ownerUserId).toBe(ownerUserId);
    expect(job.mimeType).toBe("audio/m4a");

    // Simulates the background worker picking the job up (worker-main.ts's voiceTranscriptionWorker).
    transcriber.enqueue("Remind me to pick up the dry cleaning this Friday afternoon.");
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Pick up the dry cleaning",
        startDate: { iso_date: "2026-09-04", approximate_text: null },
        startTime: null,
        timezone: null,
        location: null,
        isAllDay: true,
        confidenceNotes: "Spoken reminder, date inferred from 'this Friday'.",
      }),
    );

    await ingestion.processVoiceTranscription(job);

    expect(transcriber.calls).toHaveLength(1);
    expect(transcriber.calls[0]?.mimeType).toBe("audio/m4a");

    // The real transcript is what got stored — not fabricated, not the snippet placeholder.
    const [afterTranscription] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId));
    expect(afterTranscription?.transcript).toBe("Remind me to pick up the dry cleaning this Friday afternoon.");

    // Proves the transcript reached the SAME classifyAndExtract pipeline manual-text capture uses: the
    // domain classifier and calendar extractor were both actually invoked...
    expect(ai.calls).toContain("domain_classifier_v1");
    expect(ai.calls).toContain("calendar_event_extraction_v1");
    const classifierRequest = ai.requests.find((r) => r.extractorName === "domain_classifier_v1");
    expect(classifierRequest?.userContent).toContain("pick up the dry cleaning");

    // ...and a real calendar_events row (plus its own inbox item) actually got created from it, exactly
    // like a typed manual-text capture describing the same thing would.
    const [calendarEvent] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    expect(calendarEvent?.title).toBe("Pick up the dry cleaning");

    const finalSourceEvent = afterTranscription!;
    expect(finalSourceEvent.processingState).toBe("needs_review"); // classifyAndExtract's own "something was filed" outcome

    // Cleanup — same pattern as this file's sibling ingestion tests.
    await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
  });

  it("a genuinely untranscribable clip leaves the voice note as a raw, playable recording — never fabricated, never crashes", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const storage = new InMemoryObjectStorage();
    const queue = new RecordingQueueProducer();
    const transcriber = new FakeVoiceTranscriber(); // nothing enqueued — mirrors a real transcriber's "couldn't transcribe" response
    const ingestion = buildIngestion(storage, ai, queue, transcriber);

    const { sourceEventId } = await ingestion.ingestVoiceNote({
      ownerUserId,
      householdId: null,
      buffer: Buffer.from("fake silent/corrupted audio bytes"),
      mimeType: "audio/wav",
    });

    const job = queue.voiceTranscriptionJobs[0]!;
    await expect(ingestion.processVoiceTranscription(job)).resolves.toBeUndefined(); // must not throw

    const [finalSourceEvent] = await db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId));
    expect(finalSourceEvent?.transcript).toBeNull();
    expect(finalSourceEvent?.processingState).toBe("filed"); // "nothing more to do" — not stuck, not crashed

    // No AI extraction call ever happened — a null transcript never reaches classifyAndExtract, matching
    // this codebase's "never fabricate" discipline (no invented text, no invented classification).
    expect(ai.calls).toHaveLength(0);

    // The recording itself is still there and playable regardless of the failed transcription.
    const [captureInboxItem] = await db.select().from(schema.inboxItems).where(eq(schema.inboxItems.sourceEventId, sourceEventId));
    expect(captureInboxItem?.category).toBe("voice_note");

    await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
    await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
  });
});
