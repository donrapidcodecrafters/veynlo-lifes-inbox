import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, instantTemporal } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { SearchIndexService } from "../search/search-index.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { TripsService } from "../trips/trips.service";
import type { PreferencesService } from "../preferences/preferences.service";

/**
 * Found live via manual QA: `IngestionService.ingestFeedCalendarEvent` (the write path every provider/device
 * calendar-sync connector, including `IcsAdapter`, funnels through) never called `searchIndex.upsert` — every
 * other `calendarEvents` writer in this file does, right after its own insert/update. A synced event was
 * findable on Timeline/its own detail page yet completely invisible to Search. This proves both the initial
 * insert AND a later update (a changed/re-synced event) land in `search_documents` with the current title.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubTrips = { clusterSegment: async () => ({ tripId: "trip_stub", segmentId: "tseg_stub", isNewSegment: true, isNewTrip: true }) } as unknown as TripsService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

describe("IngestionService.ingestFeedCalendarEvent — search-index wiring", () => {
  let db: Database;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `feed-cal-search-${ownerUserId}@example.com`, displayName: "Feed Calendar Search Test" });
      ingestion = new IngestionService(
        db,
        undefined as never,
        stubNotifications,
        stubStorage,
        stubMalwareScanner,
        stubEntitlements,
        stubAutomation,
        stubConflicts,
        stubTrips,
        stubPreferences,
        undefined, // memories
        undefined, // documents
        undefined, // riskPolicy
        undefined, // featureFlags
        new SearchIndexService(db), // searchIndex — the dependency this test actually exercises
      );
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping feed-calendar search-index test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("a newly-synced feed calendar event is written to search_documents", async () => {
    if (!dbAvailable) return;
    const uid = `uid-${generateId("calendarEvent")}`;
    await ingestion.ingestFeedCalendarEvent({
      provider: "ics",
      ownerUserId,
      householdId: null,
      connectionId: null,
      uid,
      title: "Winter Solstice Gathering",
      start: instantTemporal(new Date("2026-12-21T18:00:00Z").toISOString(), "UTC"),
      end: null,
      isAllDay: false,
      location: "Community Hall",
    });

    const [event] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    expect(event?.title).toBe("Winter Solstice Gathering");

    const [doc] = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.resourceId, event!.id));
    expect(doc).toBeTruthy();
    expect(doc?.resourceType).toBe("calendar_event");
    expect(doc?.title).toBe("Winter Solstice Gathering");
    expect(doc?.deletedAt).toBeNull();
  });

  it("re-syncing the same event (an update) keeps search_documents current, not stale", async () => {
    if (!dbAvailable) return;
    const uid = `uid-${generateId("calendarEvent")}`;
    await ingestion.ingestFeedCalendarEvent({
      provider: "ics",
      ownerUserId,
      householdId: null,
      connectionId: null,
      uid,
      title: "Team Standup",
      start: instantTemporal(new Date("2026-11-03T15:00:00Z").toISOString(), "UTC"),
      end: null,
      isAllDay: false,
      location: "Room A",
    });
    const [firstEvent] = await db
      .select()
      .from(schema.calendarEvents)
      .where(eq(schema.calendarEvents.providerEventId, uid));

    // Re-sync with a changed title/location (the feed's organizer renamed/relocated the event) — this hits
    // the `existingEvent` UPDATE branch, not the insert branch, in ingestFeedCalendarEvent.
    await ingestion.ingestFeedCalendarEvent({
      provider: "ics",
      ownerUserId,
      householdId: null,
      connectionId: null,
      uid,
      title: "Team Standup (Renamed)",
      start: instantTemporal(new Date("2026-11-03T15:00:00Z").toISOString(), "UTC"),
      end: null,
      isAllDay: false,
      location: "Room B",
    });

    const [doc] = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.resourceId, firstEvent!.id));
    expect(doc?.title).toBe("Team Standup (Renamed)");
    expect(doc?.bodyText).toBe("Room B");
  });
});
