import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type TemporalValue } from "@veynlo/core";
import { TripsService } from "./trips.service";
import { SharingService } from "../sharing/sharing.service";
import { ListsService } from "../lists/lists.service";
import { ScheduleService } from "../schedule/schedule.service";
import { ConflictService } from "../schedule/conflict.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { AssetsService } from "../assets/assets.service";
import type { MemoriesService } from "../memories/memories.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => true,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubAssets = {} as unknown as AssetsService;
const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;

function instantValue(d: Date): TemporalValue {
  return { precision: "instant", instantUtc: d.toISOString(), date: null, timezone: null, sourceText: null };
}

/**
 * Real integration test against real Postgres (mirrors trips.service.test.ts's own rationale) — covers the
 * four spec-named trip-segment user actions this audit added: "Open confirmation" (segmentEvidence),
 * "Add calendar" (addSegmentToCalendar, exercised against a REAL ScheduleService so a genuine
 * `calendar_events` row is created — not a stub), and "Set check-in reminder" (setSegmentCheckInReminder).
 */
describe("TripsService — segment actions", () => {
  let db: Database;
  let trips: TripsService;
  let schedule: ScheduleService;
  let ownerUserId: string;
  let otherUserId: string;
  let tripId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const sharing = new SharingService(db);
    const lists = new ListsService(db, stubHouseholds, sharing, stubMemories);
    const conflicts = new ConflictService(db, stubHouseholds);
    schedule = new ScheduleService(db, stubHouseholds, stubNotifications, conflicts, stubAssets);
    trips = new TripsService(db, stubHouseholds, sharing, lists, schedule);
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `segment-actions-owner-${ownerUserId}@example.com`, displayName: "Segment Actions Owner" },
        { id: otherUserId, email: `segment-actions-other-${otherUserId}@example.com`, displayName: "Segment Actions Other" },
      ]);
      tripId = generateId("trip");
      await db.insert(schema.trips).values({ id: tripId, ownerUserId, label: "Test trip", travelerUserIds: [ownerUserId] });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping TripsService segment-action tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.tripSegments).where(eq(schema.tripSegments.tripId, tripId));
      await db.delete(schema.trips).where(eq(schema.trips.id, tripId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  it("'Open confirmation' — returns the source event evidence for a segment with sourceEventId, and null for one without", async () => {
    if (!dbAvailable) return;
    const sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email_message",
      contentHash: `hash-${sourceEventId}`,
      subjectLine: "Your flight confirmation TA123",
      snippet: "Thanks for booking with Test Air...",
      fromAddress: "noreply@testair.example",
      occurredAt: new Date(),
      idempotencyKey: `idem-${sourceEventId}`,
      processingState: "filed",
    });
    const withEvidenceId = generateId("tripSegment");
    const withoutEvidenceId = generateId("tripSegment");
    await db.insert(schema.tripSegments).values([
      { id: withEvidenceId, tripId, ownerUserId, kind: "flight", providerName: "Test Air", detailsJson: {}, confidenceBand: "high", sourceEventId },
      { id: withoutEvidenceId, tripId, ownerUserId, kind: "flight", providerName: "Test Air", detailsJson: {}, confidenceBand: "verified", sourceEventId: null },
    ]);

    const evidence = await trips.segmentEvidence(withEvidenceId, ownerUserId);
    expect(evidence).toBeTruthy();
    expect(evidence!.subjectLine).toBe("Your flight confirmation TA123");
    expect(evidence!.snippet).toContain("Test Air");

    const noEvidence = await trips.segmentEvidence(withoutEvidenceId, ownerUserId);
    expect(noEvidence).toBeNull();
  });

  it("'Add calendar' — creates a real calendar_events row from a dated segment, titled by kind + provider", async () => {
    if (!dbAvailable) return;
    const start = new Date(Date.now() + 5 * 86_400_000);
    const end = new Date(start.getTime() + 3 * 3_600_000);
    const segmentId = generateId("tripSegment");
    await db.insert(schema.tripSegments).values({
      id: segmentId,
      tripId,
      ownerUserId,
      kind: "flight",
      providerName: "Test Air",
      locationLabel: "JFK -> LIS",
      startAt: instantValue(start),
      startAtSort: start,
      endAt: instantValue(end),
      endAtSort: end,
      detailsJson: {},
      confidenceBand: "high",
    });

    const result = await trips.addSegmentToCalendar(segmentId, ownerUserId, { reminderMinutesBefore: 120 });
    expect(result.id).toBeTruthy();

    const [event] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, result.id));
    expect(event).toBeTruthy();
    expect(event!.title).toBe("Flight — Test Air");
    expect(event!.ownerUserId).toBe(ownerUserId);
    expect(event!.reminderMinutesBefore).toBe(120);
    expect(event!.startSort?.getTime()).toBe(start.getTime());
    expect(event!.householdId).toBeNull();

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, result.id));
  });

  it("'Add calendar' — rejects a segment with no known date instead of creating an undated event", async () => {
    if (!dbAvailable) return;
    const undatedSegmentId = generateId("tripSegment");
    await db.insert(schema.tripSegments).values({ id: undatedSegmentId, tripId, ownerUserId, kind: "ticket", providerName: "Test Venue", detailsJson: {}, confidenceBand: "needs_review" });

    await expect(trips.addSegmentToCalendar(undatedSegmentId, ownerUserId, {})).rejects.toMatchObject({ response: { code: "NO_SEGMENT_DATE" } });
  });

  it("'Set check-in reminder' — succeeds for flight/lodging, rejects for rental/ticket, and is owner-only", async () => {
    if (!dbAvailable) return;
    const flightId = generateId("tripSegment");
    const rentalId = generateId("tripSegment");
    await db.insert(schema.tripSegments).values([
      { id: flightId, tripId, ownerUserId, kind: "flight", providerName: "Test Air", detailsJson: {}, confidenceBand: "high" },
      { id: rentalId, tripId, ownerUserId, kind: "rental", providerName: "Test Rentals", detailsJson: {}, confidenceBand: "high" },
    ]);

    await trips.setSegmentCheckInReminder(flightId, ownerUserId, { checkInReminderMinutesBefore: 180 });
    const [flightRow] = await db.select().from(schema.tripSegments).where(eq(schema.tripSegments.id, flightId));
    expect(flightRow!.checkInReminderMinutesBefore).toBe(180);

    await expect(trips.setSegmentCheckInReminder(rentalId, ownerUserId, { checkInReminderMinutesBefore: 60 })).rejects.toMatchObject({ response: { code: "NOT_CHECK_IN_ELIGIBLE" } });

    await expect(trips.setSegmentCheckInReminder(flightId, otherUserId, { checkInReminderMinutesBefore: 30 })).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });

  /**
   * Gap-close: the trip detail page had NO manual "add segment" UI at all (confirmed live — segments only
   * ever arrived via AI email ingestion, or a direct API call to this same endpoint with no kind-specific
   * detail fields wired through it). `addManualSegment` previously always wrote `detailsJson: {}` regardless
   * of what the caller sent — this proves the kind-specific fields (mirroring IngestionService.
   * extractTripSegment's own detailsJson shape) now actually land, are readable back via tripDetail, and
   * that an omitted field is simply absent (not written as an explicit null).
   */
  it("'Add segment' (manual) — stores kind-specific detailsJson fields (flight/lodging), and is owner-only", async () => {
    if (!dbAvailable) return;
    const { id: flightSegmentId } = await trips.addManualSegment(tripId, ownerUserId, {
      kind: "flight",
      providerName: "Test Air",
      confirmationNumber: "ABC123",
      startDateIso: "2027-03-01",
      flightNumber: "TA204",
      departureAirport: "JFK",
      arrivalAirport: "LAX",
      seat: "14C",
    });
    const flightDetail = await trips.tripDetail(tripId, ownerUserId);
    const flightSegment = flightDetail.segments.find((s) => s.id === flightSegmentId);
    expect(flightSegment?.detailsJson).toMatchObject({ flightNumber: "TA204", departureAirport: "JFK", arrivalAirport: "LAX", seat: "14C" });
    expect(flightSegment?.detailsJson).not.toHaveProperty("propertyName"); // omitted fields aren't written at all

    const { id: lodgingSegmentId } = await trips.addManualSegment(tripId, ownerUserId, {
      kind: "lodging",
      providerName: "Test Hotel",
      startDateIso: "2027-03-01",
      endDateIso: "2027-03-05",
      propertyName: "Test Hotel Downtown",
      roomType: "King Suite",
      guestCount: 2,
    });
    const lodgingDetail = await trips.tripDetail(tripId, ownerUserId);
    const lodgingSegment = lodgingDetail.segments.find((s) => s.id === lodgingSegmentId);
    expect(lodgingSegment?.detailsJson).toMatchObject({ propertyName: "Test Hotel Downtown", roomType: "King Suite", guestCount: 2 });

    await expect(trips.addManualSegment(tripId, otherUserId, { kind: "flight" })).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });

    await db.delete(schema.tripSegments).where(eq(schema.tripSegments.id, flightSegmentId));
    await db.delete(schema.tripSegments).where(eq(schema.tripSegments.id, lodgingSegmentId));
  });
});
