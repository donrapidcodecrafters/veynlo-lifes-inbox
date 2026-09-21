import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * A flight confirmation becoming a trip segment, end to end, without a model call.
 *
 * Appendix A lists 23 travel targets. Every one of them sat in the "served by the email pipeline" column,
 * which in practice meant "a model reads the prose" — so a household that turned AI processing off got
 * nothing from any of them, and every other household paid for inference to recover a confirmation number
 * the airline had already stated in a machine-readable field of the same email.
 *
 * `schema-org-reservations.test.ts` proves the parser. This proves what the parser cannot: that the
 * reservation routes to the trip extractor, that its stated fields beat the model's where it stated them,
 * that a flight survives a classifier which called the message irrelevant, and that a household with AI
 * processing turned off gets the flight with the model never called at all — asserted against the
 * provider's own call log rather than assumed.
 *
 * Note what is NOT claimed: that markup removes the model call on the ordinary path. It does not, by
 * design — markup has no vocabulary for a cancellation deadline, and that is among the most valuable
 * things this app extracts from a travel email.
 *
 * Every database write is real. Only the model is faked, and the point of most of these is that it is
 * never reached.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
const stubStorage = {} as unknown as ObjectStorage;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubAutomation = { evaluateEvent: async () => {} } as unknown as AutomationService;
const stubConflicts = { detectOverlaps: async () => [] } as unknown as ConflictService;
const stubPreferences = { isCategoryEnabled: async () => true } as unknown as PreferencesService;
const stubEntitlements = { assertStorageQuota: async () => {}, getCapability: async () => true } as unknown as EntitlementsService;

/** Records what was handed to the trip clusterer, which is where a segment's fields actually land. */
function recordingTrips() {
  const segments: Record<string, unknown>[] = [];
  const service = {
    clusterSegment: async (params: Record<string, unknown>) => {
      segments.push(params);
      return { tripId: `trp_${segments.length}`, segmentId: `seg_${segments.length}`, isNewSegment: true, isNewTrip: true };
    },
  } as unknown as TripsService;
  return { service, segments };
}

function gmailMessageWithMarkup(id: string, subject: string, jsonLd: unknown, plainText = "Your trip is confirmed.") {
  const html = `<html><body><p>${plainText}</p><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></body></html>`;
  return {
    id,
    payload: {
      mimeType: "multipart/alternative",
      headers: [
        { name: "Subject", value: subject },
        { name: "From", value: "confirmations@airline.test" },
        { name: "To", value: "alex@example.com" },
        { name: "Date", value: "Fri, 18 Sep 2026 14:02:11 +0000" },
      ],
      parts: [
        { mimeType: "text/plain", body: { data: Buffer.from(plainText, "utf8").toString("base64url") } },
        { mimeType: "text/html", body: { data: Buffer.from(html, "utf8").toString("base64url") } },
      ],
    },
  };
}

const flightMarkup = (reservationNumber: string) => ({
  "@context": "https://schema.org",
  "@type": "FlightReservation",
  reservationNumber,
  reservationStatus: "http://schema.org/ReservationConfirmed",
  underName: { "@type": "Person", name: "Alex Rivera" },
  reservedTicket: { "@type": "Ticket", ticketedSeat: { "@type": "Seat", seatNumber: "14C" } },
  reservationFor: {
    "@type": "Flight",
    flightNumber: "UA 123",
    airline: { "@type": "Airline", name: "United Airlines" },
    departureAirport: { "@type": "Airport", iataCode: "SFO" },
    arrivalAirport: { "@type": "Airport", iataCode: "JFK" },
    departureTime: "2026-04-15T18:30:00-07:00",
    arrivalTime: "2026-04-16T03:05:00-04:00",
  },
});

describe("a declared reservation through the ingestion pipeline", () => {
  let db: Database;
  let ai: FakeModelProvider;
  let trips: ReturnType<typeof recordingTrips>;
  let ingestion: IngestionService;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({
        id: ownerUserId,
        email: `travel-markup-${ownerUserId}@example.com`,
        displayName: "Travel Markup Test",
      });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "gmail",
        feasibilityClass: "direct_api",
        scopes: ["gmail.readonly"],
        enabledCategories: ["travel"],
        health: "healthy",
      });
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "schema.org travel ingestion tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  beforeEach(() => {
    ai = new FakeModelProvider();
    trips = recordingTrips();
    ingestion = new IngestionService(db, ai, stubNotifications, stubStorage, stubMalwareScanner, stubEntitlements, stubAutomation, stubConflicts, trips.service, stubPreferences);
  });

  it("files a flight the classifier missed entirely", async () => {
    if (!dbAvailable) return;
    /**
     * The claim that is actually worth making when AI is available.
     *
     * An earlier version of this test asserted "no model call at all" here, which is simply not what the
     * code does and never was: with AI available the classifier runs and the extractor runs, on purpose,
     * because markup has no vocabulary for a cancellation deadline. Asserting it would have been asserting
     * a design this repo deliberately rejected.
     *
     * What markup does contribute on that path is a floor. The classifier reads prose, and an airline
     * confirmation is frequently a wall of images around one ld+json block — so it is told here that the
     * message is irrelevant, exactly as it would report on such a body, and the flight is filed anyway.
     */
    const reservationNumber = `RX-${generateId("trip").slice(-8)}`;
    ai.enqueue("domain_classifier_v1", fakeExtraction({ domains: ["irrelevant"], confidenceNotes: "mostly images" }));

    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-flight-${reservationNumber}`, "Your flight is confirmed", flightMarkup(reservationNumber)),
    });

    expect(trips.segments, "the classifier said irrelevant and the declared reservation was lost with it").toHaveLength(1);
    const segment = trips.segments[0]!;
    expect(segment.confirmationNumber).toBe(reservationNumber);
    expect(segment.kind).toBe("flight");
    expect(segment.providerName).toBe("United Airlines");
    // Guarding the guard: if the classifier were never called, this test would pass for the wrong reason.
    expect(ai.calls.filter((c) => c === "domain_classifier_v1").length).toBe(1);
  });

  it("keeps the departure time, not just the date", async () => {
    if (!dbAvailable) return;
    // A flight filed without its time is a flight somebody can miss. This is the single field most worth
    // guarding on a travel record.
    const reservationNumber = `RX-${generateId("trip").slice(-8)}`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-time-${reservationNumber}`, "Your flight is confirmed", flightMarkup(reservationNumber)),
    });
    const segment = trips.segments[0]!;
    const startAt = segment.startAt as { instantUtc: string | null; date: string | null } | null;
    expect(startAt).not.toBeNull();
    // 18:30 at -07:00 is 01:30 UTC the following day. Getting this wrong by an hour is the failure mode
    // that matters, so the assertion is on the instant rather than on the date alone.
    expect(startAt?.instantUtc).toBe("2026-04-16T01:30:00.000Z");
  });

  it("still gets the trip for a household that has turned AI processing OFF", async () => {
    if (!dbAvailable) return;
    // The whole reason this path is worth having. An airline stating its own flight number is not
    // inference, and a privacy choice about AI should not cost somebody their flights.
    await db.update(schema.users).set({ aiProcessingEnabled: false }).where(eq(schema.users.id, ownerUserId));
    try {
      const reservationNumber = `RX-${generateId("trip").slice(-8)}`;
      await ingestion.ingestGmailMessage({
        ownerUserId,
        householdId: null,
        connectionId,
        message: gmailMessageWithMarkup(`msg-noai-${reservationNumber}`, "Your flight is confirmed", flightMarkup(reservationNumber)),
      });
      expect(trips.segments).toHaveLength(1);
      expect(trips.segments[0]!.confirmationNumber).toBe(reservationNumber);
      expect(ai.calls.filter((c) => c === "trip_segment_extraction_v1").length).toBe(0);
    } finally {
      await db.update(schema.users).set({ aiProcessingEnabled: true }).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("lets the model fill what the markup has no vocabulary for", async () => {
    if (!dbAvailable) return;
    // Markup never states a cancellation deadline, a baggage allowance or the policy text, and a
    // cancellation deadline is among the most valuable things this app extracts. Taking the markup and
    // skipping the model would trade a real capability for a saving that was never the point.
    const reservationNumber = `RX-${generateId("trip").slice(-8)}`;
    ai.enqueue(
      "trip_segment_extraction_v1",
      fakeExtraction({
        kind: "flight",
        providerName: null,
        confirmationNumber: null,
        locationLabel: null,
        destinationCityOrRegion: "New York",
        startDate: null,
        startTime: null,
        endDate: null,
        endTime: null,
        timezone: null,
        cancellationDeadlineDate: { iso_date: "2026-04-08", approximate_text: null },
        policyEvidenceText: "Changes are free until 7 days before departure.",
        travelerNamesOnReservation: [],
        cancellationMentioned: null,
        delayMentioned: null,
        flightNumber: null,
        departureAirport: null,
        arrivalAirport: null,
        seat: null,
        baggageInfo: "1 checked bag",
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
        confidenceNotes: "from the model",
      }),
    );

    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-merge-${reservationNumber}`, "Your flight is confirmed", flightMarkup(reservationNumber)),
    });

    const segment = trips.segments[0]!;
    // The markup's fields win where it stated them...
    expect(segment.confirmationNumber).toBe(reservationNumber);
    expect(segment.providerName).toBe("United Airlines");
    // ...and the model's survive where it did not.
    const details = segment.detailsJson as Record<string, unknown> | undefined;
    expect(details?.baggageInfo).toBe("1 checked bag");
    expect(segment.policyEvidenceText).toBe("Changes are free until 7 days before departure.");
  });

  it("files a cancellation the airline declared", async () => {
    if (!dbAvailable) return;
    const reservationNumber = `RX-${generateId("trip").slice(-8)}`;
    const cancelled = { ...flightMarkup(reservationNumber), reservationStatus: "http://schema.org/ReservationCancelled" };
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-cancel-${reservationNumber}`, "Your flight was cancelled", cancelled),
    });
    expect(trips.segments[0]!.cancellationMentioned).toBe(true);
  });

  it("does not claim a booking is fine when the markup says nothing about its status", async () => {
    if (!dbAvailable) return;
    // "No status stated" and "stated as not cancelled" are different claims, and only the first is true
    // here. Filing `false` would be this app asserting something the sender never said.
    const reservationNumber = `RX-${generateId("trip").slice(-8)}`;
    const noStatus = { ...flightMarkup(reservationNumber), reservationStatus: undefined };
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-nostatus-${reservationNumber}`, "Your flight", noStatus),
    });
    // toBeNull, not toBeFalsy: `false` is falsy too, and the whole point of this test is the difference
    // between "not stated" and "stated as not cancelled". Falsification caught the weaker assertion —
    // the break that makes this app assert the second stayed green against it.
    expect(trips.segments[0]!.cancellationMentioned).toBeNull();
  });

  it("files a hotel booking from the property's own markup", async () => {
    if (!dbAvailable) return;
    const reservationNumber = `H-${generateId("trip").slice(-8)}`;
    await ingestion.ingestGmailMessage({
      ownerUserId,
      householdId: null,
      connectionId,
      message: gmailMessageWithMarkup(`msg-hotel-${reservationNumber}`, "Your stay is confirmed", {
        "@context": "https://schema.org",
        "@type": "LodgingReservation",
        reservationNumber,
        checkinTime: "2026-04-15T15:00:00-04:00",
        checkoutTime: "2026-04-18T11:00:00-04:00",
        reservationFor: { "@type": "LodgingBusiness", name: "The Harbour Hotel" },
      }),
    });
    const segment = trips.segments[0]!;
    expect(segment.kind).toBe("lodging");
    expect(segment.confirmationNumber).toBe(reservationNumber);
    expect(segment.propertyName ?? (segment.detailsJson as Record<string, unknown>)?.propertyName).toBe("The Harbour Hotel");
  });
});
