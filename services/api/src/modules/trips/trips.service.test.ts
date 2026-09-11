import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type TemporalValue } from "@veynlo/core";
import { TripsService, type IncomingTripSegment } from "./trips.service";
import { SharingService } from "../sharing/sharing.service";
import { ListsService } from "../lists/lists.service";
import type { HouseholdService } from "../household/household.service";
import type { MemoriesService } from "../memories/memories.service";
import type { ScheduleService } from "../schedule/schedule.service";

/**
 * Every date below is relative to now, never pinned.
 *
 * The paths these tests exercise compare an event's date against the clock — reschedule reconciliation
 * only looks at still-upcoming events, the subscription state machine advances anything whose date has
 * passed — so a hardcoded date stops testing the behaviour and starts testing the window, silently, on a
 * date nobody chose. ingestion.dedup.test.ts did exactly that: pinned to 2026-09-10, green for months,
 * then failing on 2026-09-11 against a commit that touched nothing near it.
 *
 * A month out, so every scenario here is comfortably upcoming, and offsets preserve the relative spacing
 * each scenario depends on.
 */
const DATE_ANCHOR = Date.now() + 30 * 86_400_000;
const day = (offsetDays: number) => new Date(DATE_ANCHOR + offsetDays * 86_400_000).toISOString().slice(0, 10);

const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;
// This file doesn't exercise the "Add to calendar" action (see trips.segment-actions.test.ts for real
// coverage of that against a real ScheduleService/Postgres) — a minimal stub is enough to satisfy
// TripsService's constructor.
const stubSchedule = { createEvent: async () => ({ id: "evt_stub", conflicts: [] }) } as unknown as ScheduleService;

/**
 * Real integration test against real Postgres (mirrors ingestion.dedup.test.ts's own rationale) — this is
 * the one genuinely new piece of logic Phase 3's travel domain needed beyond every other extractor's
 * CRUD/dedup shape (see TripsService.clusterSegment's own doc comment), so it deserves end-to-end coverage
 * against a real DB rather than only unit-level assertions.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => true,
} as unknown as HouseholdService;

function dateValue(iso: string): TemporalValue {
  return { precision: "date", instantUtc: null, date: iso, timezone: null, sourceText: null };
}
function sortDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

function baseSegment(overrides: Partial<IncomingTripSegment>, ownerUserId: string, sourceEventId: string): IncomingTripSegment {
  return {
    ownerUserId,
    householdId: null,
    kind: "flight",
    providerName: "Test Air",
    confirmationNumber: null,
    locationLabel: "JFK -> LIS",
    destinationCityOrRegion: "Lisbon",
    startAt: dateValue(day(0)),
    startAtSort: sortDate(day(0)),
    endAt: dateValue(day(0)),
    endAtSort: sortDate(day(0)),
    detailsJson: {},
    cancellationDeadline: null,
    cancellationDeadlineSort: null,
    policyEvidenceText: null,
    confidenceBand: "high",
    sourceEventId,
    cancellationMentioned: null,
    delayMentioned: null,
    ...overrides,
  };
}

describe("TripsService", () => {
  let db: Database;
  let trips: TripsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const sharing = new SharingService(db);
    const lists = new ListsService(db, stubHouseholds, sharing, stubMemories);
    trips = new TripsService(db, stubHouseholds, sharing, lists, stubSchedule);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `trips-test-${ownerUserId}@example.com`, displayName: "Trips Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping TripsService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("creates a new trip and an auto-populated packing list for a first segment", async () => {
    if (!dbAvailable) return;
    const seg = baseSegment({ confirmationNumber: `PACK-${generateId("tripSegment")}` }, ownerUserId, generateId("sourceEvent"));
    const result = await trips.clusterSegment(seg);
    expect(result.isNewTrip).toBe(true);

    const detail = await trips.tripDetail(result.tripId, ownerUserId);
    expect(detail.trip.destinationLabel).toBe("Lisbon");
    expect(detail.trip.packingListId).toBeTruthy();
    expect(detail.segments).toHaveLength(1);

    const packingList = await db.select().from(schema.lists).where(eq(schema.lists.id, detail.trip.packingListId!)).limit(1);
    expect(packingList).toHaveLength(1);
    expect(packingList[0]!.kind).toBe("packing");
    const items = await db.select().from(schema.savedItems).where(eq(schema.savedItems.listId, detail.trip.packingListId!));
    expect(items.length).toBeGreaterThan(0);
    // TRIP-008 "AI suggestions are clearly suggestions, not facts" — every starter item is prefixed.
    expect(items.every((i) => i.label.startsWith("Suggested:"))).toBe(true);
  });

  it("adds kind-specific packing items ('source-specific required items', TRIP-008) on top of the generic starter set", async () => {
    if (!dbAvailable) return;
    const seg = baseSegment({ kind: "rental", confirmationNumber: `PACK-KIND-${generateId("tripSegment")}`, destinationCityOrRegion: "Reno" }, ownerUserId, generateId("sourceEvent"));
    const result = await trips.clusterSegment(seg);
    const detail = await trips.tripDetail(result.tripId, ownerUserId);
    const items = await db.select().from(schema.savedItems).where(eq(schema.savedItems.listId, detail.trip.packingListId!));
    const labels = items.map((i) => i.label);
    expect(labels).toContain("Suggested: Driver's license");
    expect(labels).toContain("Suggested: Proof of insurance");
    // Generic items are still present alongside the kind-specific ones.
    expect(labels).toContain("Suggested: Passport / ID");
    // A different kind gets a different, not-shared set of specific items.
    expect(labels).not.toContain("Suggested: Boarding pass / mobile check-in");
  });

  it("clusters a second, overlapping same-destination segment into the SAME trip rather than creating a new one", async () => {
    if (!dbAvailable) return;
    const first = await trips.clusterSegment(baseSegment({ kind: "flight", confirmationNumber: `CLUSTER-A-${generateId("tripSegment")}` }, ownerUserId, generateId("sourceEvent")));
    const second = await trips.clusterSegment(
      baseSegment(
        { kind: "lodging", providerName: "Lisbon Hotel", confirmationNumber: `CLUSTER-B-${generateId("tripSegment")}`, startAt: dateValue(day(1)), startAtSort: sortDate(day(1)), endAt: dateValue(day(4)), endAtSort: sortDate(day(4)) },
        ownerUserId,
        generateId("sourceEvent"),
      ),
    );
    expect(second.isNewTrip).toBe(false);
    expect(second.tripId).toBe(first.tripId);

    const detail = await trips.tripDetail(first.tripId, ownerUserId);
    expect(detail.segments).toHaveLength(2);
    // The trip's own range should have expanded to cover the later lodging checkout.
    expect(detail.trip.endDateSort?.toISOString().slice(0, 10)).toBe(day(4));
  });

  it("creates a separate trip for an unrelated destination/date range", async () => {
    if (!dbAvailable) return;
    const unrelated = await trips.clusterSegment(
      baseSegment(
        { destinationCityOrRegion: "Tokyo", confirmationNumber: `UNRELATED-${generateId("tripSegment")}`, startAt: dateValue(day(142)), startAtSort: sortDate(day(142)), endAt: dateValue(day(142)), endAtSort: sortDate(day(142)) },
        ownerUserId,
        generateId("sourceEvent"),
      ),
    );
    expect(unrelated.isNewTrip).toBe(true);
    const detail = await trips.tripDetail(unrelated.tripId, ownerUserId);
    expect(detail.trip.destinationLabel).toBe("Tokyo");
  });

  it("reconciles a second email about the same confirmation number instead of creating a sibling segment, and detects a disruption", async () => {
    if (!dbAvailable) return;
    const confirmationNumber = `RECONCILE-${generateId("tripSegment")}`;
    const first = await trips.clusterSegment(baseSegment({ confirmationNumber, destinationCityOrRegion: "Berlin", startAt: dateValue(day(22)), startAtSort: sortDate(day(22)), endAt: dateValue(day(22)), endAtSort: sortDate(day(22)) }, ownerUserId, generateId("sourceEvent")));
    expect(first.isNewSegment).toBe(true);

    // A cancellation email about the exact same reservation — same confirmation number.
    const second = await trips.clusterSegment(
      baseSegment(
        { confirmationNumber, destinationCityOrRegion: "Berlin", startAt: dateValue(day(22)), startAtSort: sortDate(day(22)), endAt: dateValue(day(22)), endAtSort: sortDate(day(22)), cancellationMentioned: true },
        ownerUserId,
        generateId("sourceEvent"),
      ),
    );
    expect(second.isNewSegment).toBe(false);
    expect(second.segmentId).toBe(first.segmentId);

    const [segment] = await db.select().from(schema.tripSegments).where(eq(schema.tripSegments.id, first.segmentId)).limit(1);
    expect(segment!.status).toBe("cancelled");
    expect(segment!.disruptionStatus).toBe("cancelled");
  });

  it("does not auto-merge when more than one existing trip ambiguously overlaps — creates a new trip and records the ambiguous candidates instead", async () => {
    if (!dbAvailable) return;
    const destination = `Ambiguous City ${generateId("trip")}`;
    // Two DIFFERENT trips are seeded directly via the manual-seed path (not clusterSegment) so they don't
    // cluster into EACH OTHER first — simulating two independently-created trips that happen to overlap in
    // date/destination (e.g. a family's separately-booked legs of the same real trip).
    const tripA = await trips.createManualTrip(ownerUserId, { destinationLabel: destination, startDateIso: day(52), endDateIso: day(56) });
    const tripB = await trips.createManualTrip(ownerUserId, { destinationLabel: destination, startDateIso: day(53), endDateIso: day(57) });
    expect(tripA.id).not.toBe(tripB.id);

    const third = await trips.clusterSegment(baseSegment({ kind: "ticket", destinationCityOrRegion: destination, confirmationNumber: `AMB-C-${generateId("tripSegment")}`, startAt: dateValue(day(54)), startAtSort: sortDate(day(54)), endAt: dateValue(day(54)), endAtSort: sortDate(day(54)) }, ownerUserId, generateId("sourceEvent")));
    expect(third.isNewTrip).toBe(true);
    expect(third.tripId).not.toBe(tripA.id);
    expect(third.tripId).not.toBe(tripB.id);

    const [thirdTrip] = await db.select().from(schema.trips).where(eq(schema.trips.id, third.tripId)).limit(1);
    expect(thirdTrip!.suggestedMergeTripIds.sort()).toEqual([tripA.id, tripB.id].sort());

    // TRIP-001 "Confirm trip merge" — the explicit resolution.
    const merged = await trips.mergeTrips(tripA.id, tripB.id, ownerUserId);
    expect(merged.id).toBe(tripA.id);
    const mergedDetail = await trips.tripDetail(tripA.id, ownerUserId);
    expect(mergedDetail.segments).toHaveLength(0); // neither manually-seeded trip had a segment of its own
    const [sourceAfterMerge] = await db.select().from(schema.trips).where(eq(schema.trips.id, tripB.id)).limit(1);
    expect(sourceAfterMerge!.deletedAt).not.toBeNull();
  });

  it("flags a passport that expires before the trip ends, and omits it from the redacted public share view", async () => {
    if (!dbAvailable) return;
    const result = await trips.clusterSegment(
      baseSegment({ destinationCityOrRegion: "Nairobi", confirmationNumber: `DOC-${generateId("tripSegment")}`, startAt: dateValue(day(234)), startAtSort: sortDate(day(234)), endAt: dateValue(day(243)), endAtSort: sortDate(day(243)) }, ownerUserId, generateId("sourceEvent")),
    );
    const documentId = generateId("document");
    await db.insert(schema.documents).values({
      id: documentId,
      ownerUserId,
      documentType: "identity_document",
      title: "My passport",
      documentKind: "passport",
      expiresAt: dateValue(day(203)), // expires BEFORE the trip ends
      expiresAtSort: sortDate(day(203)),
      tags: [],
    });

    const detail = await trips.tripDetail(result.tripId, ownerUserId);
    expect(detail.documentReadiness).toHaveLength(1);
    expect(detail.documentReadiness[0]!.severity).toBe("expires_before_trip");

    // Spec: "household trip sharing can exclude payment/ID evidence" — same VIN-omission stance as
    // AssetsService.publicVehicleContent.
    const publicView = await trips.publicShareContent(result.tripId);
    expect(JSON.stringify(publicView)).not.toContain("confirmationNumber");
    expect((publicView as unknown as { documentReadiness?: unknown }).documentReadiness).toBeUndefined();

    await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  });
});
