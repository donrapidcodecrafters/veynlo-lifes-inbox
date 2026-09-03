import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { IngestionService } from "./ingestion.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import { TripsService } from "../trips/trips.service";
import { SharingService } from "../sharing/sharing.service";
import { ListsService } from "../lists/lists.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { MalwareScannerService } from "../documents/malware-scanner.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { AutomationService } from "../automation/automation.service";
import type { ConflictService } from "../schedule/conflict.service";
import type { HouseholdService } from "../household/household.service";
import type { MemoriesService } from "../memories/memories.service";
import type { ScheduleService } from "../schedule/schedule.service";
import type { PreferencesService } from "../preferences/preferences.service";

const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;

/**
 * Phase 3 §26 "Travel & Reservations" — end-to-end through classifyAndExtract's real domain routing (a
 * "travel"-classified email reaches extractTripSegment, not extractCalendarEvent — see
 * IngestionService.classifyAndExtract's own comment), with a REAL TripsService (not a stub) so clustering
 * is exercised for real, mirroring ingestion.dedup.test.ts's own real-Postgres rationale.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => true,
} as unknown as HouseholdService;

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const allowingEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;
// Not exercising "Add to calendar" here (see trips.segment-actions.test.ts) — a minimal stub satisfies
// TripsService's constructor.
const stubSchedule = { createEvent: async () => ({ id: "evt_stub", conflicts: [] }) } as unknown as ScheduleService;
const gatedEntitlements = { assertStorageQuota: async () => {}, getCapability: async (_userId: string, capability: string) => capability !== "travel_planning" } as unknown as EntitlementsService;

function tripSegmentExtraction(overrides: Record<string, unknown> = {}) {
  return fakeExtraction({
    kind: "flight",
    providerName: "Test Air",
    confirmationNumber: `CONF-${generateId("tripSegment")}`,
    locationLabel: "JFK -> LIS",
    destinationCityOrRegion: "Lisbon",
    startDate: { iso_date: "2026-10-10", approximate_text: null },
    startTime: null,
    endDate: { iso_date: "2026-10-10", approximate_text: null },
    endTime: null,
    timezone: null,
    cancellationDeadlineDate: null,
    policyEvidenceText: null,
    travelerNamesOnReservation: [],
    flightNumber: "TA123",
    departureAirport: "JFK",
    arrivalAirport: "LIS",
    seat: null,
    baggageInfo: null,
    propertyName: null,
    roomType: null,
    guestCount: null,
    feesInfo: null,
    vehicleOrServiceType: null,
    pickupLocation: null,
    dropoffLocation: null,
    eventName: null,
    venue: null,
    bookingUrl: null,
    cancellationMentioned: null,
    delayMentioned: null,
    confidenceNotes: "n/a",
    ...overrides,
  });
}

describe("IngestionService extractTripSegment", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `trip-extract-test-${ownerUserId}@example.com`, displayName: "Trip Extract Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping IngestionService trip-segment tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  function buildIngestion(entitlements: EntitlementsService) {
    const sharing = new SharingService(db);
    const lists = new ListsService(db, stubHouseholds, sharing, stubMemories);
    const trips = new TripsService(db, stubHouseholds, sharing, lists, stubSchedule);
    return new IngestionService(db, new FakeModelProvider(), stubNotifications, stubStorage, stubMalwareScanner, entitlements, stubAutomation, stubConflicts, trips, stubPreferences);
  }

  it("routes a 'travel' email to trip-segment extraction (not a plain calendar event) and clusters it into a new trip", async () => {
    if (!dbAvailable) return;
    const ingestion = buildIngestion(allowingEntitlements);
    const ai = (ingestion as unknown as { ai: FakeModelProvider }).ai;
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["travel"] }));
    ai.enqueue("trip_segment_extraction_v1", tripSegmentExtraction());
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Your flight to Lisbon is confirmed", bodyText: "Flight TA123, JFK to LIS, Oct 10 2026." });

    expect(ai.calls).not.toContain("calendar_event_extraction_v1");
    expect(ai.calls).toContain("trip_segment_extraction_v1");

    const segments = await db.select().from(schema.tripSegments).where(eq(schema.tripSegments.ownerUserId, ownerUserId));
    expect(segments).toHaveLength(1);
    expect(segments[0]!.kind).toBe("flight");

    const trip = await db.select().from(schema.trips).where(eq(schema.trips.id, segments[0]!.tripId)).limit(1);
    expect(trip).toHaveLength(1);
    expect(trip[0]!.destinationLabel).toBe("Lisbon");
  });

  it("does not extract a trip segment when travel_planning is gated off", async () => {
    if (!dbAvailable) return;
    const ingestion = buildIngestion(gatedEntitlements);
    const ai = (ingestion as unknown as { ai: FakeModelProvider }).ai;
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["travel"] }));
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Gated travel email", bodyText: "Flight confirmation for a gated account." });

    expect(ai.calls).not.toContain("trip_segment_extraction_v1");
    const segments = await db
      .select({ id: schema.tripSegments.id })
      .from(schema.tripSegments)
      .where(eq(schema.tripSegments.ownerUserId, ownerUserId));
    // Only the segment from the previous (allowed) test should exist — this gated run added nothing.
    expect(segments).toHaveLength(1);
  });

  it("TRIP-002/003/005 — captures baggageInfo/feesInfo/bookingUrl only when the email states them, never inferring them", async () => {
    if (!dbAvailable) return;
    const ingestion = buildIngestion(allowingEntitlements);
    const ai = (ingestion as unknown as { ai: FakeModelProvider }).ai;

    // Positive case: a flight email that explicitly states baggage and a booking URL.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["travel"] }));
    ai.enqueue(
      "trip_segment_extraction_v1",
      tripSegmentExtraction({
        confirmationNumber: "CONF-BAGGAGE-TEST",
        // A distinct date (well outside the 3-day provider-fallback match window) so this doesn't get
        // reconciled INTO the earlier "Test Air" segment from the first test in this file (reconcileSegment
        // doesn't touch detailsJson at all — this must land as its own new segment to actually exercise the
        // baggageInfo/bookingUrl write path).
        startDate: { iso_date: "2026-11-20", approximate_text: null },
        endDate: { iso_date: "2026-11-20", approximate_text: null },
        baggageInfo: "1 checked bag, seat 14C",
        bookingUrl: "https://www.testair.example/manage-booking",
      }),
    );
    await ingestion.ingestManualText({
      ownerUserId,
      householdId: null,
      subject: "Your flight — baggage and booking link included",
      bodyText: "1 checked bag, seat 14C. Manage your booking: https://www.testair.example/manage-booking",
    });

    // Negative case: a lodging email with NOTHING about fees stated at all.
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["travel"] }));
    ai.enqueue(
      "trip_segment_extraction_v1",
      tripSegmentExtraction({
        kind: "lodging",
        providerName: "Test Hotel",
        confirmationNumber: "CONF-NOFEE-TEST",
        propertyName: "Test Hotel Downtown",
        flightNumber: null,
        departureAirport: null,
        arrivalAirport: null,
      }),
    );
    await ingestion.ingestManualText({ ownerUserId, householdId: null, subject: "Your hotel reservation is confirmed", bodyText: "Test Hotel Downtown, check-in Oct 10 2026. No mention of any fee." });

    const segments = await db.select().from(schema.tripSegments).where(eq(schema.tripSegments.ownerUserId, ownerUserId));
    const baggageSegment = segments.find((s) => (s.detailsJson as { baggageInfo?: string | null }).baggageInfo === "1 checked bag, seat 14C");
    expect(baggageSegment).toBeTruthy();
    expect((baggageSegment!.detailsJson as { bookingUrl?: string | null }).bookingUrl).toBe("https://www.testair.example/manage-booking");

    const lodgingSegment = segments.find((s) => s.kind === "lodging" && s.providerName === "Test Hotel");
    expect(lodgingSegment).toBeTruthy();
    // Never invented — the model's own output was null, and that's exactly what's stored.
    expect((lodgingSegment!.detailsJson as { feesInfo?: string | null }).feesInfo ?? null).toBeNull();
  });
});
