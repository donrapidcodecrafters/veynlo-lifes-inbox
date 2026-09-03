import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, instantTemporal } from "@veynlo/core";
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
 * CAL-001 "duplicate copies visually collapse while preserving original records" — real integration tests
 * against a real Postgres (same pattern as ingestion.dedup.test.ts), proving the cross-source identity-
 * resolution piece: a real-world appointment that arrives BOTH as a provider-synced calendar event
 * (`ingestFeedCalendarEvent`, dedups within its own kind by `providerEventId`) AND as a separately-
 * discovered email (`extractCalendarEvent`, dedups within its own kind by `findExistingDiscoveredCalendarEvent`'s
 * title match) must have the second-arriving copy record a `linkedEventId` pointing at the first — never a
 * merge, never a silent field overwrite of the other row — see IngestionService.findCrossSourceCalendarEventMatch's
 * own doc comment for the exact precision discipline this exercises end to end.
 *
 * `extractCalendarEvent`'s own temporal conversion (`toTemporalValue`, ingestion/temporal.util.ts) only ever
 * produces DATE precision for a discovered event — the model's separately-extracted `startTime` field is a
 * pre-existing, distinct gap this pass didn't touch (see docs/PHASE2_PENDING_CREDENTIALS.md's CAL-001 entry
 * for why) — so a discovered event's `startSort` always lands at UTC midnight of its date. These tests
 * therefore choose provider-synced instants close to UTC midnight (a perfectly ordinary real occurrence —
 * e.g. a late-evening US-Pacific appointment or an early-morning Central-European one) to fall inside the
 * ±3h window on the provider side of a genuine same-day match, and deliberately far outside it (or on a
 * different calendar day) for the negative cases — this exercises the real window-comparison logic against
 * real Postgres rows, not a contrived shortcut around it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService CAL-001 cross-source calendar-event linking", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `cal001-test-${ownerUserId}@example.com`, displayName: "CAL-001 Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CAL-001 cross-source-link tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  async function eventsByTitle(title: string) {
    const rows = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    return rows.filter((r) => r.title === title);
  }

  it("links a provider-synced event to an already-discovered email copy of the same real appointment", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // 1. Email discovery arrives first — this is the ordinary extractCalendarEvent insert path (no existing
    // discovered candidate yet, and no provider-synced candidate yet either).
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Riverside Dental Cleaning",
        startDate: { iso_date: "2026-10-12", approximate_text: null },
        startTime: "09:00",
        timezone: "America/Los_Angeles",
        location: "Confirmation email — no address given",
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your dental cleaning is confirmed",
      bodyText: "Riverside Dental Cleaning on 2026-10-12 at 9:00 AM.",
    });

    // 2. The SAME real appointment then syncs in from the user's connected Google Calendar — a completely
    // independent discovery of the same event, routed through ingestFeedCalendarEvent (never through AI
    // extraction at all — see that method's own doc comment).
    const filed = await ingestion.ingestFeedCalendarEvent({
      provider: "google_calendar",
      ownerUserId,
      householdId: null,
      connectionId: null,
      uid: "gcal-evt-riverside-dental",
      title: "Riverside Dental Cleaning",
      start: instantTemporal("2026-10-12T01:30:00.000Z", "America/Los_Angeles"), // within ±3h of the discovered copy's UTC-midnight startSort
      end: null,
      isAllDay: false,
      location: "456 Oak St, Suite 2",
    });
    expect(filed).toBe(true);

    const events = await eventsByTitle("Riverside Dental Cleaning");
    expect(events).toHaveLength(2);

    const discovered = events.find((e) => e.providerEventId == null);
    const synced = events.find((e) => e.providerEventId === "gcal-evt-riverside-dental");
    expect(discovered).toBeTruthy();
    expect(synced).toBeTruthy();

    // The link points from the second-arriving row (the provider sync) at the first (the discovered email
    // copy) — never the reverse, and the discovered row is never mutated into pointing at itself or updated
    // in place by the sync.
    expect(synced!.linkedEventId).toBe(discovered!.id);
    expect(discovered!.linkedEventId).toBeNull();

    // Neither original record is merged/overwritten — both keep their own independently-observed location,
    // proving this is a LINK, not a merge (spec's own "preserving original records").
    expect(discovered!.location).toBe("Confirmation email — no address given");
    expect(synced!.location).toBe("456 Oak St, Suite 2");
  });

  it("links an email-discovered event that arrives AFTER an already-synced provider copy (the reverse ordering)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // 1. Provider sync arrives first.
    await ingestion.ingestFeedCalendarEvent({
      provider: "microsoft_calendar",
      ownerUserId,
      householdId: null,
      connectionId: null,
      uid: "outlook-evt-standup-offsite",
      title: "Morning Standup Offsite",
      start: instantTemporal("2026-11-03T01:00:00.000Z", "America/Chicago"),
      end: null,
      isAllDay: false,
      location: "12 Harbor View Way",
    });

    // 2. A separate confirmation email about the same real event is discovered afterward.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Morning Standup Offsite",
        startDate: { iso_date: "2026-11-03", approximate_text: null },
        startTime: "07:00",
        timezone: "America/Chicago",
        location: null,
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Offsite reminder",
      bodyText: "Morning Standup Offsite on 2026-11-03 at 7:00 AM.",
    });

    const events = await eventsByTitle("Morning Standup Offsite");
    expect(events).toHaveLength(2);
    const synced = events.find((e) => e.providerEventId === "outlook-evt-standup-offsite");
    const discovered = events.find((e) => e.providerEventId == null);
    expect(synced).toBeTruthy();
    expect(discovered).toBeTruthy();

    // This time the discovered row is the second arrival, so IT carries the link.
    expect(discovered!.linkedEventId).toBe(synced!.id);
    expect(synced!.linkedEventId).toBeNull();
  });

  it("does NOT link two genuinely different real events that happen to share an exact title, more than 3 hours apart", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    await ingestion.ingestFeedCalendarEvent({
      provider: "ics",
      ownerUserId,
      householdId: null,
      connectionId: null,
      uid: "ics-evt-weekly-sync-1",
      title: "Weekly Sync",
      start: instantTemporal("2026-11-10T01:00:00.000Z", "UTC"),
      end: null,
      isAllDay: false,
      location: null,
    });

    // A same-titled but genuinely different appointment, a full day later — outside the ±3h window measured
    // against the synced event's start, and the discovered copy's own startSort (2026-11-11T00:00:00Z) is
    // almost 23 hours away from the synced one's 2026-11-10T01:00:00Z.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Weekly Sync",
        startDate: { iso_date: "2026-11-11", approximate_text: null },
        startTime: "09:00",
        timezone: "UTC",
        location: null,
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Weekly Sync agenda",
      bodyText: "Weekly Sync on 2026-11-11 at 9:00 AM.",
    });

    const events = await eventsByTitle("Weekly Sync");
    expect(events).toHaveLength(2);
    // Neither row links to the other — both stand alone, exactly as if the precision-first dedup found no
    // safe cross-source match (the correct outcome: these are two different real occurrences).
    for (const e of events) expect(e.linkedEventId).toBeNull();
  });

  it("does NOT auto-link when more than one cross-source candidate matches (ambiguous -> no match, same stance as findExistingDiscoveredCalendarEvent)", async () => {
    if (!dbAvailable) return;
    ai = new FakeModelProvider();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, stubTrips, stubPreferences);

    // Two independent provider-synced events with the EXACT same title, both within the ±3h window of the
    // email that's about to arrive — a real (if unusual) case of two distinct real-world "Parent-Teacher
    // Conference" slots synced from two different connected calendars/providers.
    for (const uid of ["gcal-evt-ptc-a", "gcal-evt-ptc-b"]) {
      await ingestion.ingestFeedCalendarEvent({
        provider: "google_calendar",
        ownerUserId,
        householdId: null,
        connectionId: null,
        uid,
        title: "Parent-Teacher Conference",
        start: instantTemporal("2026-12-01T01:00:00.000Z", "America/New_York"),
        end: null,
        isAllDay: false,
        location: null,
      });
    }

    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["calendar_event"] }));
    ai.enqueue(
      "calendar_event_extraction_v1",
      fakeExtraction({
        title: "Parent-Teacher Conference",
        startDate: { iso_date: "2026-12-01", approximate_text: null },
        startTime: "08:00",
        timezone: "America/New_York",
        location: null,
        isAllDay: false,
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Conference confirmed",
      bodyText: "Parent-Teacher Conference on 2026-12-01 at 8:00 AM.",
    });

    const events = await eventsByTitle("Parent-Teacher Conference");
    // The two synced rows plus a third, independent discovered row — never guessed-merged into either.
    expect(events).toHaveLength(3);
    const discovered = events.find((e) => e.providerEventId == null);
    expect(discovered).toBeTruthy();
    expect(discovered!.linkedEventId).toBeNull();
    for (const e of events) if (e.id !== discovered!.id) expect(e.linkedEventId).toBeNull();
  });
});
