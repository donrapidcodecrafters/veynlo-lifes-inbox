import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * The calendar invite attached to an email, read as an event instead of OCR'd as a document.
 *
 * Every attachment went one way before this: uploaded as a generic document and queued for optical
 * character recognition. For a PDF or a photo that is right. For the `.ics` an airline, a hotel, a
 * restaurant, a school and every meeting invite attaches, it meant running OCR over a text file and filing
 * a document nobody would open — while the event it describes, with an exact start time and timezone
 * already stated in it, never reached the calendar at all.
 *
 * Nothing here needs inferring, so it works with AI processing turned off and cannot be misread the way
 * prose can.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "t", segmentId: "s", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

/** Records what the documents path was asked to store, so "not uploaded" is checkable rather than assumed. */
function recordingDocuments() {
  const uploads: Record<string, unknown>[] = [];
  return { uploads, service: { upload: async (params: Record<string, unknown>) => { uploads.push(params); return { documentId: `doc_${uploads.length}` }; } } };
}

const invite = (uid: string, extra = "") =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Airline//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SUMMARY:Check-in opens",
    "LOCATION:SFO Terminal 3",
    "DTSTART:20260415T183000Z",
    "DTEND:20260415T193000Z",
    extra,
    "END:VEVENT",
    "END:VCALENDAR",
  ]
    .filter(Boolean)
    .join("\r\n");

/**
 * A message and its already-fetched attachment bytes.
 *
 * `attachments` is a SIBLING of `message` on IngestGmailParams, not a field inside it — the adapter fetches
 * those bytes separately. An earlier version of this file nested them, so nothing reached the attachment
 * path at all and two assertions ("not uploaded as a document", "a cancelled meeting is not filed") passed
 * for entirely the wrong reason. The PDF test is what exposed it, by failing.
 */
function emailWithAttachment(id: string, attachment: { filename: string; mimeType: string; body: string }, subject = "Your booking") {
  return {
    message: {
    id,
    payload: {
      mimeType: "multipart/mixed",
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: "confirmations@airline.test" },
        { name: "To", value: "alex@example.com" },
        { name: "Date", value: "Fri, 18 Sep 2026 14:02:11 +0000" },
      ],
      parts: [{ mimeType: "text/plain", body: { data: Buffer.from("Your booking is confirmed.", "utf8").toString("base64url") } }],
    },
    },
    attachments: [{ filename: attachment.filename, mimeType: attachment.mimeType, buffer: Buffer.from(attachment.body, "utf8") }],
  };
}

describe("a calendar invite attached to an email", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let documents: ReturnType<typeof recordingDocuments>;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `ics-attach-${ownerUserId}@example.com`, displayName: "ICS Attachment Test" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "gmail",
        feasibilityClass: "direct_api",
        scopes: ["gmail.readonly"],
        enabledCategories: ["schedule"],
        health: "healthy",
      });
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "calendar attachment tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  beforeEach(() => {
    ai = new FakeModelProvider();
    documents = recordingDocuments();
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
      // The constructor takes an optional `memories` before `documents`; passing the documents service in
      // that slot would silently wire it as the wrong dependency and leave `this.documents` undefined,
      // which would make "not uploaded as a document" pass for entirely the wrong reason.
      undefined as never,
      documents.service as never,
    );
  });

  async function eventsFor(uid: string) {
    const rows = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    return rows.filter((r) => r.providerEventId === uid);
  }

  it("becomes a real calendar event, with the time the invite stated", async () => {
    if (!dbAvailable) return;
    const uid = `inv-${generateId("calendarEvent").slice(-10)}@airline.test`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      ...emailWithAttachment(`msg-${uid}`, { filename: "invite.ics", mimeType: "text/calendar; method=REQUEST", body: invite(uid) }),
    });

    const filed = await eventsFor(uid);
    expect(filed, "the attached invite never reached the calendar").toHaveLength(1);
    expect(filed[0]?.title).toBe("Check-in opens");
    expect(filed[0]?.location).toBe("SFO Terminal 3");
    // The time is the whole point. An invite states it exactly; nothing here is inferred.
    expect(filed[0]?.startSort?.toISOString()).toBe("2026-04-15T18:30:00.000Z");
  });

  it("is not ALSO uploaded as a document to be OCR'd", async () => {
    if (!dbAvailable) return;
    // Running optical character recognition over a text file, then leaving a duplicate in the Documents
    // vault, is the behaviour this replaces — not something to keep doing alongside it.
    const uid = `inv-${generateId("calendarEvent").slice(-10)}@airline.test`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      ...emailWithAttachment(`msg-${uid}`, { filename: "invite.ics", mimeType: "text/calendar", body: invite(uid) }),
    });
    expect(documents.uploads).toHaveLength(0);
  });

  it("still uploads a PDF attachment as a document", async () => {
    if (!dbAvailable) return;
    /**
     * The guard against over-reaching: a boarding-pass PDF must keep working exactly as before.
     *
     * The subject here says "receipt" ON PURPOSE, and that is worth explaining rather than leaving as an
     * odd detail. A PDF does NOT make a message relevant — only markup and, now, a calendar invite do — so
     * an attachment on a message the prefilter drops is never processed at all. This test needs the
     * message to survive that gate in order to test the thing it is actually about.
     *
     * That is pre-existing behaviour, not something this change introduced, and it is left alone
     * deliberately: making any attachment confer relevance would let every newsletter with a logo through.
     * Whether a PDF should count is a real question and a separate one — recorded here rather than
     * silently answered, because the version of this test that did not explain it read like a passing
     * feature rather than a boundary.
     */
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      ...emailWithAttachment("msg-pdf", { filename: "boarding-pass.pdf", mimeType: "application/pdf", body: "%PDF-1.4 fake" }, "Your receipt"),
    });
    expect(documents.uploads).toHaveLength(1);
    expect(documents.uploads[0]?.title).toBe("boarding-pass.pdf");
  });

  it("recognises a calendar file the sender mislabelled", async () => {
    if (!dbAvailable) return;
    // Real senders label these `application/octet-stream` and rely on the filename. Checking only the
    // declared type loses every one of them.
    const uid = `inv-${generateId("calendarEvent").slice(-10)}@airline.test`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      ...emailWithAttachment(`msg-${uid}`, { filename: "meeting.ics", mimeType: "application/octet-stream", body: invite(uid) }),
    });
    expect(await eventsFor(uid)).toHaveLength(1);
  });

  it("recognises one whose filename is wrong but whose type is right", async () => {
    if (!dbAvailable) return;
    // And the mirror case: `text/calendar` sent as `invite.dat`. Checking only the extension loses these.
    const uid = `inv-${generateId("calendarEvent").slice(-10)}@airline.test`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      ...emailWithAttachment(`msg-${uid}`, { filename: "invite.dat", mimeType: "text/calendar", body: invite(uid) }),
    });
    expect(await eventsFor(uid)).toHaveLength(1);
  });

  it("does not file a meeting the organiser cancelled", async () => {
    if (!dbAvailable) return;
    // A CANCEL invite carries STATUS:CANCELLED. Filing it as an ordinary event would put a meeting on
    // somebody's calendar that the organiser had just called off — worse than filing nothing.
    const uid = `inv-${generateId("calendarEvent").slice(-10)}@airline.test`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      ...emailWithAttachment(`msg-${uid}`, { filename: "cancel.ics", mimeType: "text/calendar", body: invite(uid, "STATUS:CANCELLED") }),
    });
    expect(await eventsFor(uid)).toHaveLength(0);
  });

  it("does not lose the message when the attachment is not really a calendar", async () => {
    if (!dbAvailable) return;
    // An attachment announcing itself as text/calendar and containing something else is a normal thing to
    // receive. It must not throw, and it must not stop the rest of the message being processed.
    await expect(
      ingestion.ingestGmailMessage({
        ownerUserId,
        householdId: null,
        connectionId,
        ...emailWithAttachment("msg-garbage", { filename: "invite.ics", mimeType: "text/calendar", body: "this is not a calendar" }),
      }),
    ).resolves.not.toThrow();
  });

  it("reads it with AI processing turned OFF", async () => {
    if (!dbAvailable) return;
    // A VEVENT states its time. Nothing is inferred, so a privacy choice about AI should not cost somebody
    // the meeting.
    await db.update(schema.users).set({ aiProcessingEnabled: false }).where(eq(schema.users.id, ownerUserId));
    try {
      const uid = `inv-${generateId("calendarEvent").slice(-10)}@airline.test`;
      await ingestion.ingestGmailMessage({
        ownerUserId,
        householdId: null,
        connectionId,
        ...emailWithAttachment(`msg-${uid}`, { filename: "invite.ics", mimeType: "text/calendar", body: invite(uid) }),
      });
      expect(await eventsFor(uid)).toHaveLength(1);
      expect(ai.calls).toHaveLength(0);
    } finally {
      await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    }
  });
});
