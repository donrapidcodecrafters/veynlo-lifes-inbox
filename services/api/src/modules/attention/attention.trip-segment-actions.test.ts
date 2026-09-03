import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type TemporalValue } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

function instantValue(d: Date): TemporalValue {
  return { precision: "instant", instantUtc: d.toISOString(), date: null, timezone: null, sourceText: null };
}

/**
 * TRIP-002/TRIP-003 "Set check-in reminder" and TRIP-004 "Rental-return time/location alert" — the two new
 * `AttentionService.scanAndFileDeadlines` scans this audit added. Before this, `trip_segments` was never
 * scanned for either: `checkInReminderMinutesBefore` had no reader at all, and nothing scanned a rental
 * segment's own `endAt` for an approaching return deadline (confirmed gap). Mirrors
 * attention.travel.test.ts's own real-Postgres rationale.
 */
describe("AttentionService.scanAndFileDeadlines — trip-segment check-in reminder and rental return", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let tripId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `attention-tripseg-${ownerUserId}@example.com`, displayName: "Attention Trip Segment Test" });
      tripId = generateId("trip");
      await db.insert(schema.trips).values({ id: tripId, ownerUserId, label: "Test trip", travelerUserIds: [ownerUserId] });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService trip-segment tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.tripSegments).where(eq(schema.tripSegments.tripId, tripId));
      await db.delete(schema.trips).where(eq(schema.trips.id, tripId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("files a trip_check_in_reminder item for a flight once its check-in lead time is reached, but not before and not for a rental", async () => {
    if (!dbAvailable) return;
    const dueSegmentId = generateId("tripSegment");
    const notYetSegmentId = generateId("tripSegment");
    const rentalSegmentId = generateId("tripSegment");

    // Starts in 30 minutes; a 60-minute-before reminder is already due (remindAt = now - 30min, in the past).
    const dueStart = new Date(Date.now() + 30 * 60_000);
    // Starts in 10 days; a 60-minute-before reminder isn't due for days yet.
    const notYetStart = new Date(Date.now() + 10 * 86_400_000);

    await db.insert(schema.tripSegments).values([
      {
        id: dueSegmentId,
        tripId,
        ownerUserId,
        kind: "flight",
        providerName: "Test Air",
        locationLabel: "JFK",
        startAt: instantValue(dueStart),
        startAtSort: dueStart,
        detailsJson: {},
        confidenceBand: "verified",
        checkInReminderMinutesBefore: 60,
      },
      {
        id: notYetSegmentId,
        tripId,
        ownerUserId,
        kind: "flight",
        providerName: "Test Air",
        locationLabel: "JFK",
        startAt: instantValue(notYetStart),
        startAtSort: notYetStart,
        detailsJson: {},
        confidenceBand: "verified",
        checkInReminderMinutesBefore: 60,
      },
      {
        id: rentalSegmentId,
        tripId,
        ownerUserId,
        kind: "rental",
        providerName: "Test Rentals",
        locationLabel: "LAX",
        startAt: instantValue(dueStart),
        startAtSort: dueStart,
        endAt: instantValue(new Date(dueStart.getTime() + 3 * 86_400_000)),
        endAtSort: new Date(dueStart.getTime() + 3 * 86_400_000),
        detailsJson: {},
        confidenceBand: "verified",
        // A rental has no "check-in" concept — see tripSegments.checkInReminderMinutesBefore's own doc
        // comment; the scanner itself also restricts to flight/lodging kinds regardless of this being set.
        checkInReminderMinutesBefore: 60,
      },
    ]);

    await attention.scanAndFileDeadlines();

    const [dueItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "trip_segment"), eq(schema.attentionItems.linkedResourceId, dueSegmentId)));
    expect(dueItem).toBeTruthy();
    expect(dueItem!.reasonCode).toBe("trip_check_in_reminder");
    expect(dueItem!.reasonText).toContain("Test Air");
    expect(dueItem!.reasonText).toContain("Flight check-in");

    const [notYetItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "trip_segment"), eq(schema.attentionItems.linkedResourceId, notYetSegmentId)));
    expect(notYetItem).toBeUndefined();

    const [rentalCheckInItem] = await db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, "trip_segment"), eq(schema.attentionItems.linkedResourceId, rentalSegmentId), eq(schema.attentionItems.reasonCode, "trip_check_in_reminder")));
    expect(rentalCheckInItem).toBeUndefined();
  });

  it("files a rental_return_due item for an approaching rental return, using the dropoff location from detailsJson — but not for a cancelled rental", async () => {
    if (!dbAvailable) return;
    const activeRentalId = generateId("tripSegment");
    const cancelledRentalId = generateId("tripSegment");
    const returnAt = new Date(Date.now() + 5 * 3_600_000); // 5 hours from now — within the lookahead window

    await db.insert(schema.tripSegments).values([
      {
        id: activeRentalId,
        tripId,
        ownerUserId,
        kind: "rental",
        providerName: "Test Rentals",
        locationLabel: "LAX",
        startAt: instantValue(new Date(Date.now() - 2 * 86_400_000)),
        startAtSort: new Date(Date.now() - 2 * 86_400_000),
        endAt: instantValue(returnAt),
        endAtSort: returnAt,
        detailsJson: { dropoffLocation: "LAX Rental Return Center" },
        confidenceBand: "verified",
      },
      {
        id: cancelledRentalId,
        tripId,
        ownerUserId,
        kind: "rental",
        providerName: "Test Rentals",
        locationLabel: "LAX",
        startAt: instantValue(new Date(Date.now() - 2 * 86_400_000)),
        startAtSort: new Date(Date.now() - 2 * 86_400_000),
        endAt: instantValue(returnAt),
        endAtSort: returnAt,
        detailsJson: {},
        confidenceBand: "verified",
        status: "cancelled",
      },
    ]);

    await attention.scanAndFileDeadlines();

    const [activeItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "trip_segment"), eq(schema.attentionItems.linkedResourceId, activeRentalId)));
    expect(activeItem).toBeTruthy();
    expect(activeItem!.reasonCode).toBe("rental_return_due");
    expect(activeItem!.reasonText).toContain("LAX Rental Return Center");
    expect(activeItem!.urgency).toBe("important"); // 5 hours out — beyond the <=180min "critical" band, within the <=1440min "important" one

    const [cancelledItem] = await db.select().from(schema.attentionItems).where(and(eq(schema.attentionItems.linkedResourceType, "trip_segment"), eq(schema.attentionItems.linkedResourceId, cancelledRentalId)));
    expect(cancelledItem).toBeUndefined();
  });
});
