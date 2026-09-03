import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { ListsService } from "../lists/lists.service";
import { ScheduleService } from "../schedule/schedule.service";
import { identityRecordSafeColumns } from "../identity-records/identity-records.util";
import type { CreateShareLinkDto } from "../sharing/dto";
import { SearchIndexService } from "../search/search-index.service";
import type { CreateTripDto, UpdateTripDto, CreateTravelCreditDto, CreateManualTripSegmentDto, AddSegmentToCalendarDto, SetSegmentCheckInReminderDto } from "./dto";

/** A candidate segment coming from ingestion, before it has an id — see `clusterSegment`'s own doc comment. */
export interface IncomingTripSegment {
  ownerUserId: string;
  householdId: string | null;
  kind: "flight" | "lodging" | "rental" | "ticket";
  providerName: string | null;
  confirmationNumber: string | null;
  locationLabel: string | null;
  destinationCityOrRegion: string | null;
  startAt: TemporalValue | null;
  startAtSort: Date | null;
  endAt: TemporalValue | null;
  endAtSort: Date | null;
  detailsJson: Record<string, unknown>;
  cancellationDeadline: TemporalValue | null;
  cancellationDeadlineSort: Date | null;
  policyEvidenceText: string | null;
  confidenceBand: string;
  sourceEventId: string;
  cancellationMentioned: boolean | null;
  delayMentioned: boolean | null;
}

const CLUSTER_DATE_TOLERANCE_MS = 2 * 86_400_000; // a trip's own date range is extended this far when checking overlap — an early-morning flight the day before a hotel check-in shouldn't miss the cluster
const SIX_MONTHS_MS = 182 * 86_400_000;
const RESCHEDULE_THRESHOLD_MS = 30 * 60_000; // a schedule shift smaller than this (rounding/timezone noise) isn't treated as a real "changed" disruption

function normalize(s: string | null): string | null {
  return s && s.trim().length > 0 ? s.trim().toLowerCase() : null;
}

/** Precision-first — matches only an exact string or a clean substring relationship (e.g. "Paris" vs "Paris, France"), never a fuzzy/similarity score. */
function destinationsMatch(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** Converts a segment's `startAt`/`endAt` TemporalValue into the ISO string shape ScheduleService.createEvent
 * expects (a plain YYYY-MM-DD for a date-precision value, a full ISO datetime for an instant-precision one).
 * Anything less precise than that (approximate/unknown, or null) has no single instant a calendar event
 * could honestly be anchored to — returns null, and addSegmentToCalendar treats that as "nothing to add." */
function temporalToIso(value: TemporalValue | null): string | null {
  if (!value) return null;
  if (value.precision === "date" && value.date) return value.date;
  if (value.precision === "instant" && value.instantUtc) return value.instantUtc;
  return null;
}

function rangesOverlap(aStart: Date | null, aEnd: Date | null, bStart: Date | null, bEnd: Date | null, toleranceMs: number): boolean {
  const as = aStart ?? aEnd;
  const ae = aEnd ?? aStart;
  const bs = bStart ?? bEnd;
  const be = bEnd ?? bStart;
  if (!as || !ae || !bs || !be) return false;
  return as.getTime() - toleranceMs <= be.getTime() && bs.getTime() <= ae.getTime() + toleranceMs;
}

/**
 * TRIP-001..TRIP-009 "Travel & Reservations" (spec §26). See packages/db/src/schema/travel.ts's module
 * doc comment for the schema design (one polymorphic `tripSegments` table, a separate `travelCredits`
 * table). Clustering (`clusterSegment`) is the one genuinely new piece of logic this domain needed beyond
 * every other extractor's CRUD/dedup shape — see its own doc comment for the precision-first stance.
 */
@Injectable()
export class TripsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(ListsService) private readonly lists: ListsService,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional
    // `new TripsService(...)` test construction keeps compiling unchanged.
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  /** Same FAM-006 delegation-scoped visibility pattern as every other domain service this session
   * (CommerceService/ListsService/DocumentsService's own identically-named helper). */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "trips:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  private async assertTripAccess(tripId: string, userId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1);
    if (!trip || trip.deletedAt) throw new NotFoundException({ code: "TRIP_NOT_FOUND", message: "Trip not found." });
    if (trip.ownerUserId === userId) return trip;
    if (trip.householdId) {
      const delegatedIds = await this.households.delegatedHouseholdIds(userId, "trips:read");
      if (delegatedIds.includes(trip.householdId)) return trip;
      if (await this.households.isActiveMember(trip.householdId, userId)) return trip;
    }
    if (trip.travelerUserIds.includes(userId)) return trip;
    if (await this.sharing.hasActiveGrant("trip", tripId, userId)) return trip;
    throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this trip." });
  }

  private async assertOwnedTrip(tripId: string, ownerUserId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1);
    if (!trip || trip.deletedAt) throw new NotFoundException({ code: "TRIP_NOT_FOUND", message: "Trip not found." });
    if (trip.ownerUserId !== ownerUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the trip owner can do that." });
    return trip;
  }

  private segmentsDisrupted(segments: Array<{ disruptionStatus: string }>): boolean {
    return segments.some((s) => s.disruptionStatus !== "none");
  }

  async listTrips(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("trip", userId);
    const baseCondition = await this.ownerOrDelegatedHousehold(userId, schema.trips.ownerUserId, schema.trips.householdId);
    const accessCondition = grantedIds.length > 0 ? or(baseCondition, inArray(schema.trips.id, grantedIds))! : baseCondition;
    const rows = await this.db
      .select()
      .from(schema.trips)
      .where(and(accessCondition, isNull(schema.trips.deletedAt)))
      .orderBy(asc(schema.trips.startDateSort));
    if (rows.length === 0) return [];
    const segments = await this.db.select().from(schema.tripSegments).where(inArray(schema.tripSegments.tripId, rows.map((r) => r.id)));
    const byTrip = new Map<string, typeof segments>();
    for (const seg of segments) byTrip.set(seg.tripId, [...(byTrip.get(seg.tripId) ?? []), seg]);
    return rows.map((trip) => {
      const tripSegs = byTrip.get(trip.id) ?? [];
      return { ...trip, segmentCount: tripSegs.length, disrupted: this.segmentsDisrupted(tripSegs) };
    });
  }

  async tripDetail(tripId: string, userId: string) {
    const trip = await this.assertTripAccess(tripId, userId);
    const segments = await this.db.select().from(schema.tripSegments).where(eq(schema.tripSegments.tripId, tripId)).orderBy(asc(schema.tripSegments.startAtSort));
    const credits = await this.db.select().from(schema.travelCredits).where(eq(schema.travelCredits.tripId, tripId));
    const documentReadiness = await this.computeDocumentReadiness(trip);
    const sharingState = (await this.sharing.computeSharingStates("trip", [tripId])).get(tripId) ?? (trip.visibility === "household" ? "household" : "private");
    // Ambiguous-merge candidates need enough of the OTHER trip's own fields to render a real prompt
    // ("did you mean this trip to Lisbon, Jun 3-9?"), not just an id — TRIP-001 "asks when confidence is weak".
    const suggestedMergeTrips =
      trip.suggestedMergeTripIds.length > 0
        ? await this.db.select().from(schema.trips).where(and(inArray(schema.trips.id, trip.suggestedMergeTripIds), isNull(schema.trips.deletedAt)))
        : [];
    return { trip, segments, credits, documentReadiness, sharingState, disrupted: this.segmentsDisrupted(segments), suggestedMergeTrips };
  }

  /** TRIP-006 "Travel document readiness" — never invents a visa/entry rule (see documents.ts's own doc
   * comment); flags only "before" (expires during/before the trip) or "soon after" (within a ~6-month
   * heuristic window many destinations informally expect, explicitly framed as "verify yourself" — never
   * asserted as a real jurisdiction rule). */
  private async computeDocumentReadiness(trip: typeof schema.trips.$inferSelect) {
    const tripEnd = trip.endDateSort ?? trip.startDateSort;
    if (!tripEnd) return [];
    // "Identity & Legal Continuity" (ID-001) now gives passports a dedicated, more-authoritative record than
    // this generic Documents-vault `documentKind==="passport"` fallback (built before that domain existed) —
    // prefer `identity_records` once the owner has at least one dedicated, still-current passport record,
    // falling back to the original Documents-vault query for a user who hasn't added one yet, so this
    // never regresses for them (see AttentionService.scanAndFileDeadlines's identical preference, kept in
    // sync deliberately rather than sharing one function, for the same "two different response shapes"
    // reasoning as that file's own analogous duplication elsewhere in this codebase).
    const identityPassports = await this.db
      .select(identityRecordSafeColumns)
      .from(schema.identityRecords)
      .where(
        and(
          eq(schema.identityRecords.ownerUserId, trip.ownerUserId),
          eq(schema.identityRecords.recordType, "passport"),
          ne(schema.identityRecords.status, "renewed"),
          isNull(schema.identityRecords.deletedAt),
          isNotNull(schema.identityRecords.expirationDateSort),
        ),
      );
    const docs =
      identityPassports.length > 0
        ? identityPassports.map((r) => ({ id: r.id, title: r.label, documentKind: "passport", expiresAt: r.expirationDate, expiresAtSort: r.expirationDateSort }))
        : await this.db
            .select()
            .from(schema.documents)
            .where(and(eq(schema.documents.ownerUserId, trip.ownerUserId), eq(schema.documents.documentKind, "passport"), isNull(schema.documents.deletedAt), isNotNull(schema.documents.expiresAtSort)));
    return docs
      .map((d) => {
        const expires = d.expiresAtSort!;
        let severity: "expires_before_trip" | "expires_soon_after_trip" | null = null;
        if (expires.getTime() <= tripEnd.getTime()) severity = "expires_before_trip";
        else if (expires.getTime() - tripEnd.getTime() < SIX_MONTHS_MS) severity = "expires_soon_after_trip";
        return { documentId: d.id, title: d.title, documentKind: d.documentKind, expiresAt: d.expiresAt, severity };
      })
      .filter((r) => r.severity !== null);
  }

  /** TRIP-001 "Create trip from connected confirmations or manual seed" — the manual-seed fallback. */
  async createManualTrip(userId: string, dto: CreateTripDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    const startDate: TemporalValue | null = dto.startDateIso ? { precision: "date", instantUtc: null, date: dto.startDateIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const endDate: TemporalValue | null = dto.endDateIso ? { precision: "date", instantUtc: null, date: dto.endDateIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const id = generateId("trip");
    await this.db.insert(schema.trips).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      label: dto.label ?? (dto.destinationLabel ? `Trip to ${dto.destinationLabel}` : "New trip"),
      destinationLabel: dto.destinationLabel ?? null,
      startDate,
      startDateSort: startDate?.date ? new Date(`${startDate.date}T00:00:00Z`) : null,
      endDate,
      endDateSort: endDate?.date ? new Date(`${endDate.date}T00:00:00Z`) : null,
      travelerUserIds: [userId],
    });
    await this.searchIndex?.upsert({
      resourceType: "trip",
      resourceId: id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      sensitivity: "sensitive",
      title: dto.label ?? (dto.destinationLabel ? `Trip to ${dto.destinationLabel}` : "New trip"),
      bodyText: dto.destinationLabel ?? "",
    });
    await this.ensurePackingList(id, userId, dto.householdId ?? null);
    return { id };
  }

  /** Manual segment entry — the same fallback CreateStoreCreditDtoSchema-style manual path gives every
   * other AI-first domain in this app; attaches to an existing trip the caller owns rather than
   * re-running clustering (a manually-added segment already knows which trip it belongs to). Was
   * previously the ONLY way in for a manually-added segment on the web/mobile trip detail page — but
   * neither client actually had an "Add segment" form wired to it (confirmed live: a trip's segments only
   * ever arrived via AI email ingestion). `detailsJson` is built from whichever kind-specific fields the
   * dto carries (see CreateManualTripSegmentDtoSchema's own doc comment) — omitted ones stay `undefined`
   * and are dropped, not written as an explicit null, so a manually-entered segment's detailsJson has the
   * same "only what's actually known" shape as an AI-extracted one's. */
  async addManualSegment(tripId: string, userId: string, dto: CreateManualTripSegmentDto): Promise<{ id: string }> {
    const trip = await this.assertOwnedTrip(tripId, userId);
    const startAt: TemporalValue | null = dto.startDateIso ? { precision: "date", instantUtc: null, date: dto.startDateIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const endAt: TemporalValue | null = dto.endDateIso ? { precision: "date", instantUtc: null, date: dto.endDateIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const startAtSort = startAt?.date ? new Date(`${startAt.date}T00:00:00Z`) : null;
    const endAtSort = endAt?.date ? new Date(`${endAt.date}T00:00:00Z`) : null;
    const detailsJson: Record<string, unknown> = {};
    const detailFields = [
      "flightNumber",
      "departureAirport",
      "arrivalAirport",
      "seat",
      "baggageInfo",
      "propertyName",
      "roomType",
      "guestCount",
      "feesInfo",
      "vehicleOrServiceType",
      "pickupLocation",
      "dropoffLocation",
      "eventName",
      "venue",
      "bookingUrl",
    ] as const;
    for (const field of detailFields) {
      if (dto[field] !== undefined && dto[field] !== null) detailsJson[field] = dto[field];
    }
    const id = generateId("tripSegment");
    await this.db.insert(schema.tripSegments).values({
      id,
      tripId,
      ownerUserId: trip.ownerUserId,
      kind: dto.kind,
      providerName: dto.providerName ?? null,
      confirmationNumber: dto.confirmationNumber ?? null,
      locationLabel: dto.locationLabel ?? null,
      startAt,
      startAtSort,
      endAt,
      endAtSort,
      detailsJson, // see tripSegments.detailsJson's own schema doc comment on why this is always passed explicitly
      confidenceBand: "verified", // user-entered directly — same reasoning as CommerceService.createStoreCredit
      sourceEventId: null,
    });
    await this.expandTripRange(tripId, startAtSort, endAtSort, null);
    return { id };
  }

  // --- Segment actions: evidence / add to calendar / check-in reminder -------------------------------

  private async assertSegmentAccess(segmentId: string, userId: string) {
    const [segment] = await this.db.select().from(schema.tripSegments).where(eq(schema.tripSegments.id, segmentId)).limit(1);
    if (!segment) throw new NotFoundException({ code: "SEGMENT_NOT_FOUND", message: "Segment not found." });
    const trip = await this.assertTripAccess(segment.tripId, userId);
    return { segment, trip };
  }

  /** Same indirect-evidence-resolution PATTERN as ScheduleService.evidenceForSourceEvent — kept local
   * rather than shared for the same reason that method's own doc comment gives (avoiding coupling two
   * otherwise-independent services over a few lines of logic). Unlike calendar_events, `trip_segments` has
   * its own direct `sourceEventId` column (see that column's schema doc comment), so there's no
   * evidenceViaInboxItem-style indirection needed here — this goes straight from the segment to its source
   * email. */
  private async evidenceForSourceEvent(sourceEventId: string | null) {
    if (!sourceEventId) return null;
    const [row] = await this.db
      .select({ event: schema.sourceEvents, connection: schema.connections })
      .from(schema.sourceEvents)
      .leftJoin(schema.connections, eq(schema.connections.id, schema.sourceEvents.connectionId))
      .where(eq(schema.sourceEvents.id, sourceEventId))
      .limit(1);
    if (!row) return null;
    return {
      sourceEventId: row.event.id,
      kind: row.event.kind,
      subjectLine: row.event.subjectLine,
      snippet: row.event.snippet,
      fromAddress: row.event.fromAddress,
      occurredAt: row.event.occurredAt,
      provider: row.connection?.provider ?? null,
    };
  }

  /** "Open confirmation" — spec-named user action on a trip segment: shows the original email's
   * subject/snippet/date this segment was extracted from. A manually-added segment (sourceEventId null) or
   * one whose source event has since been purged simply has no evidence to show — see EvidenceCard's own
   * "no source evidence available" fallback on both web and mobile. */
  async segmentEvidence(segmentId: string, userId: string) {
    const { segment } = await this.assertSegmentAccess(segmentId, userId);
    return this.evidenceForSourceEvent(segment.sourceEventId);
  }

  /**
   * "Add calendar" trip-segment action — creates a REAL `calendar_events` row via
   * ScheduleService.createEvent (the same event-creation path every other add-to-calendar action in this
   * app goes through), rather than a parallel, segment-specific notion of "on the calendar." The title is
   * derived from kind + provider/label (e.g. "Flight — United"); the segment's own start/end become the
   * event's start/end untouched. A segment with no resolvable start date (still "Date TBD") has nothing to
   * put on a calendar — rejected with a clear error rather than silently creating an undated event.
   */
  async addSegmentToCalendar(segmentId: string, userId: string, dto: AddSegmentToCalendarDto): Promise<{ id: string; conflicts: Array<typeof schema.scheduleConflicts.$inferSelect> }> {
    const { segment } = await this.assertSegmentAccess(segmentId, userId);
    const startIso = temporalToIso(segment.startAt);
    if (!startIso) throw new BadRequestException({ code: "NO_SEGMENT_DATE", message: "This segment doesn't have a known date yet." });
    const isAllDay = segment.startAt?.precision === "date";
    const endIso = temporalToIso(segment.endAt);
    const kindLabel = { flight: "Flight", lodging: "Lodging", rental: "Rental / transport", ticket: "Ticket" }[segment.kind as "flight" | "lodging" | "rental" | "ticket"] ?? "Reservation";
    const title = segment.providerName ? `${kindLabel} — ${segment.providerName}` : kindLabel;
    // Deliberately household: null — this is the CALLING user's own personal calendar (they may be viewing
    // the trip as a traveler, a delegate, or a share-grant recipient, none of which necessarily makes them
    // an active member of the trip's household; see ScheduleService.createEvent's own household-membership
    // check), never auto-shared with the trip's household just because the trip itself might be.
    return this.schedule.createEvent(userId, {
      title,
      startIso,
      endIso,
      isAllDay,
      location: segment.locationLabel,
      householdId: null,
      reminderMinutesBefore: dto.reminderMinutesBefore,
    });
  }

  /**
   * TRIP-002/TRIP-003 "Set check-in reminder" — flight/lodging only (a rental/ticket segment has no
   * "check-in" concept; see `tripSegments.checkInReminderMinutesBefore`'s own doc comment). Owner-only,
   * matching ScheduleService.setEventReminder's identical ownership stance. Wired into
   * AttentionService.scanAndFileDeadlines's own travel scans, so setting this actually produces a reminder.
   */
  async setSegmentCheckInReminder(segmentId: string, userId: string, dto: SetSegmentCheckInReminderDto): Promise<void> {
    const [segment] = await this.db.select().from(schema.tripSegments).where(eq(schema.tripSegments.id, segmentId)).limit(1);
    if (!segment) throw new NotFoundException({ code: "SEGMENT_NOT_FOUND", message: "Segment not found." });
    if (segment.kind !== "flight" && segment.kind !== "lodging") {
      throw new BadRequestException({ code: "NOT_CHECK_IN_ELIGIBLE", message: "Only flight and lodging segments support a check-in reminder." });
    }
    await this.assertOwnedTrip(segment.tripId, userId);
    await this.db.update(schema.tripSegments).set({ checkInReminderMinutesBefore: dto.checkInReminderMinutesBefore, updatedAt: new Date() }).where(eq(schema.tripSegments.id, segmentId));
  }

  async updateTrip(tripId: string, userId: string, dto: UpdateTripDto): Promise<void> {
    const trip = await this.assertOwnedTrip(tripId, userId);
    const updates: Partial<typeof schema.trips.$inferInsert> = { updatedAt: new Date() };
    if (dto.label !== undefined) updates.label = dto.label;
    if (dto.status !== undefined) updates.status = dto.status;
    await this.db.update(schema.trips).set(updates).where(eq(schema.trips.id, tripId));
    // §44.4 — only the label is part of the search projection's title; a status-only update still refreshes
    // it (harmless — same idempotent upsert) but is the case that matters least here.
    if (dto.label !== undefined) {
      await this.searchIndex?.upsert({
        resourceType: "trip",
        resourceId: tripId,
        ownerUserId: trip.ownerUserId,
        householdId: trip.householdId,
        sensitivity: "sensitive",
        title: dto.label,
        bodyText: trip.destinationLabel ?? "",
      });
    }
  }

  /** TRIP-001 "add/remove traveler" — owner-only, and only real Veynlo accounts (see travelerUserIds's
   * own schema doc comment); a traveler being added must be reachable (an active household member, or
   * already the owner) so this can't be used to silently grant an unrelated account trip access. */
  async setTraveler(tripId: string, ownerUserId: string, travelerUserId: string, add: boolean): Promise<void> {
    const trip = await this.assertOwnedTrip(tripId, ownerUserId);
    if (add && travelerUserId !== ownerUserId) {
      if (!trip.householdId || !(await this.households.isActiveMember(trip.householdId, travelerUserId))) {
        throw new BadRequestException({ code: "NOT_HOUSEHOLD_MEMBER", message: "That person isn't an active member of this trip's household." });
      }
    }
    const current = new Set(trip.travelerUserIds);
    if (add) current.add(travelerUserId);
    else current.delete(travelerUserId);
    await this.db.update(schema.trips).set({ travelerUserIds: [...current], updatedAt: new Date() }).where(eq(schema.trips.id, tripId));
  }

  /**
   * TRIP-001 "Confirm trip merge" — the explicit resolution of an ambiguous clustering candidate (see
   * `clusterSegment`'s own doc comment). `sourceTripId`'s segments/credits move to `targetTripId`; the
   * source trip is soft-deleted (never hard-deleted — its id may still be referenced from an older
   * `suggestedMergeTripIds` list, which is harmless once it resolves to a deleted, inaccessible trip).
   */
  async mergeTrips(targetTripId: string, sourceTripId: string, userId: string): Promise<{ id: string }> {
    if (targetTripId === sourceTripId) throw new BadRequestException({ code: "SAME_TRIP", message: "Cannot merge a trip into itself." });
    const target = await this.assertOwnedTrip(targetTripId, userId);
    const source = await this.assertOwnedTrip(sourceTripId, userId);

    await this.db.update(schema.tripSegments).set({ tripId: target.id, updatedAt: new Date() }).where(eq(schema.tripSegments.tripId, source.id));
    await this.db.update(schema.travelCredits).set({ tripId: target.id, updatedAt: new Date() }).where(eq(schema.travelCredits.tripId, source.id));

    const travelerUserIds = [...new Set([...target.travelerUserIds, ...source.travelerUserIds])];
    const startDateSort = [target.startDateSort, source.startDateSort].filter((d): d is Date => d != null).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
    const endDateSort = [target.endDateSort, source.endDateSort].filter((d): d is Date => d != null).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const destinationLabel = mergeDestinationLabels(target.destinationLabel, source.destinationLabel);

    await this.db
      .update(schema.trips)
      .set({
        travelerUserIds,
        startDateSort,
        startDate: startDateSort === source.startDateSort ? source.startDate : target.startDate,
        endDateSort,
        endDate: endDateSort === source.endDateSort ? source.endDate : target.endDate,
        destinationLabel,
        suggestedMergeTripIds: target.suggestedMergeTripIds.filter((id) => id !== sourceTripId),
        updatedAt: new Date(),
      })
      .where(eq(schema.trips.id, target.id));
    await this.db.update(schema.trips).set({ deletedAt: new Date(), suggestedMergeTripIds: [] }).where(eq(schema.trips.id, source.id));
    return { id: target.id };
  }

  // --- Travel credits (TRIP-007) ----------------------------------------------------------------------

  async listTravelCredits(userId: string) {
    const accessCondition = await this.ownerOrDelegatedHousehold(userId, schema.travelCredits.ownerUserId, schema.travelCredits.householdId);
    return this.db.select().from(schema.travelCredits).where(accessCondition);
  }

  /** Manual entry — a goodwill/promo voucher with no cancelled segment behind it has no other way in;
   * IngestionService's extractTripSegment cancellation path is the automatic route for the common case.
   *
   * Found live during a fresh adversarial pass (two real households, via redeemTravelCredit): this never
   * set `householdId` on the inserted row, even when `dto.tripId` points at a household-shared trip —
   * `assertTripAccess`'s return value (the trip, householdId included) was discarded. That silently broke
   * BOTH halves of the "household member can see/redeem a shared trip's credit" story this domain is
   * supposed to have: `listTravelCredits` filters on `travelCredits.householdId` (never populated, so a
   * household member's `GET /v1/trips/credits/all` came back without it), and `redeemTravelCredit`'s own
   * household-inclusive access check (`credit.householdId ? ... : []`) short-circuits to owner-only the
   * instant `householdId` is null — so the "fix" a previous audit made to redeemTravelCredit could never
   * actually engage for a single manually-created credit. Confirmed live: a plain active household member
   * got 403 NOT_AUTHORIZED redeeming their own household's trip credit. */
  async createTravelCredit(userId: string, dto: CreateTravelCreditDto): Promise<{ id: string }> {
    const trip = dto.tripId ? await this.assertTripAccess(dto.tripId, userId) : null;
    const expirationDate: TemporalValue | null = dto.expirationDateIso ? { precision: "date", instantUtc: null, date: dto.expirationDateIso.slice(0, 10), timezone: null, sourceText: null } : null;
    const id = generateId("travelCredit");
    await this.db.insert(schema.travelCredits).values({
      id,
      ownerUserId: userId,
      householdId: trip?.householdId ?? null,
      tripId: dto.tripId ?? null,
      providerName: dto.providerName ?? null,
      amountMinorUnits: dto.amountMinorUnits,
      currency: dto.currency ?? "USD",
      expirationDate,
      expirationDateSort: expirationDate?.date ? new Date(`${expirationDate.date}T00:00:00Z`) : null,
      confidenceBand: "verified",
    });
    return { id };
  }

  /**
   * Found live during a requirements re-audit: this used to be a hard `ownerUserId !== userId` check, but
   * `listTravelCredits` above already shows a household member another member's travel credit via
   * `ownerOrDelegatedHousehold` — the same "list is more permissive than the action" inconsistency
   * CommerceService.redeemStoreCredit/PetsService.markRefillPickedUp both avoid by using their own
   * household-inclusive access check for the exact same "mark as used" action. Mirrors those: owner,
   * active household member, or `trips:read` delegate.
   */
  async redeemTravelCredit(creditId: string, userId: string): Promise<void> {
    const [credit] = await this.db.select().from(schema.travelCredits).where(eq(schema.travelCredits.id, creditId)).limit(1);
    if (!credit) throw new NotFoundException({ code: "TRAVEL_CREDIT_NOT_FOUND", message: "Not found." });
    if (credit.ownerUserId !== userId) {
      const householdIds = credit.householdId
        ? [...(await this.households.delegatedHouseholdIds(userId, "trips:read")), ...(await this.households.activeHouseholdIds(userId))]
        : [];
      if (!credit.householdId || !householdIds.includes(credit.householdId)) {
        throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
      }
    }
    await this.db.update(schema.travelCredits).set({ redeemed: true, redeemedAt: new Date(), updatedAt: new Date() }).where(eq(schema.travelCredits.id, creditId));
  }

  // --- Packing lists (TRIP-008) ------------------------------------------------------------------------

  /** TRIP-008 "source-specific required items" — a plain logistics category per segment `kind` (never a
   * weather/AI inference), added on top of the generic starter set below. Kept to what every reservation of
   * that kind literally requires (a flight needs a boarding pass; a rental needs the renter's license), not
   * a destination- or weather-dependent guess — see this method's own doc comment for why weather-dependent
   * items are out of scope entirely. */
  private static readonly KIND_SPECIFIC_PACKING_ITEMS: Record<IncomingTripSegment["kind"], string[]> = {
    flight: ["Boarding pass / mobile check-in", "ID matching the name on the ticket"],
    lodging: ["Reservation confirmation (printed or saved offline)"],
    rental: ["Driver's license", "Proof of insurance"],
    ticket: ["Ticket / confirmation (printed or saved offline)"],
  };

  /**
   * Reuses the Lists/savedItems feature already built this session rather than a parallel list system
   * (per this session's own design note). Idempotent via `trips.packingListId` — a second segment
   * clustering into the same trip must not spawn a second packing list (its `kind`-specific items are
   * added at *creation* time only, for whichever segment kind happened to create the list first). The
   * starter items are generic, non-weather-dependent, and explicitly prefixed "Suggested:" (spec TRIP-008
   * "AI suggestions are clearly suggestions, not facts") — weather-dependent suggestions need a live
   * weather-data provider this dev environment doesn't have configured; see
   * docs/PHASE3_PENDING_CREDENTIALS.md.
   */
  private async ensurePackingList(tripId: string, ownerUserId: string, householdId: string | null, segmentKind?: IncomingTripSegment["kind"] | null): Promise<void> {
    const [trip] = await this.db.select({ packingListId: schema.trips.packingListId, label: schema.trips.label }).from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1);
    if (!trip || trip.packingListId) return;
    const { id: listId } = await this.lists.createList(ownerUserId, { name: `Packing for ${trip.label ?? "your trip"}`, kind: "packing", householdId });
    await this.db.update(schema.trips).set({ packingListId: listId, updatedAt: new Date() }).where(eq(schema.trips.id, tripId));
    const suggested = [
      "Passport / ID",
      "Phone charger",
      "Travel documents / confirmations",
      "Toiletries",
      "Medications",
      ...(segmentKind ? TripsService.KIND_SPECIFIC_PACKING_ITEMS[segmentKind] : []),
    ];
    for (const label of suggested) {
      await this.lists.addItem(listId, ownerUserId, { label: `Suggested: ${label}` });
    }
  }

  // --- Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) --------------------------------------------

  async createResourceGrant(tripId: string, ownerUserId: string, granteeEmail: string, expiresInDays?: number): Promise<{ id: string }> {
    await this.assertOwnedTrip(tripId, ownerUserId);
    return this.sharing.createResourceGrant("trip", tripId, ownerUserId, granteeEmail, expiresInDays);
  }

  async listResourceGrants(tripId: string, ownerUserId: string) {
    await this.assertOwnedTrip(tripId, ownerUserId);
    return this.sharing.listResourceGrants("trip", tripId);
  }

  async revokeResourceGrant(grantId: string, ownerUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, ownerUserId);
  }

  async createShareLink(tripId: string, ownerUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    await this.assertOwnedTrip(tripId, ownerUserId);
    return this.sharing.createShareLink("trip", tripId, ownerUserId, dto);
  }

  async listShareLinks(tripId: string, ownerUserId: string) {
    await this.assertOwnedTrip(tripId, ownerUserId);
    return this.sharing.listShareLinks("trip", tripId);
  }

  async revokeShareLink(linkId: string, ownerUserId: string): Promise<void> {
    return this.sharing.revokeShareLink(linkId, ownerUserId);
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAccessEvents(tripId: string, ownerUserId: string) {
    await this.assertOwnedTrip(tripId, ownerUserId);
    return this.sharing.listAccessEvents("trip", tripId);
  }

  /**
   * Public, unauthenticated redemption content for a trip share link. Spec: "household trip sharing can
   * exclude payment/ID evidence" — mirrors AssetsService.publicVehicleContent's VIN omission exactly:
   * `confirmationNumber` (usable to look up/modify a real booking), `policyEvidenceText`, `detailsJson`
   * (may hold seat/room/guest specifics), and every `travelCredits`/document-readiness row are all
   * deliberately left out. A direct resource grant (a named Veynlo account) still sees the full trip via
   * `tripDetail`.
   */
  async publicShareContent(tripId: string) {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1);
    if (!trip || trip.deletedAt) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    const segments = await this.db.select().from(schema.tripSegments).where(eq(schema.tripSegments.tripId, tripId)).orderBy(asc(schema.tripSegments.startAtSort));
    return {
      label: trip.label,
      destinationLabel: trip.destinationLabel,
      startDate: trip.startDate,
      endDate: trip.endDate,
      status: trip.status,
      segments: segments.map((s) => ({ kind: s.kind, providerName: s.providerName, locationLabel: s.locationLabel, startAt: s.startAt, endAt: s.endAt, status: s.status, disruptionStatus: s.disruptionStatus })),
    };
  }

  // --- Ingestion entry point (TRIP-001/TRIP-002..005/TRIP-009) -----------------------------------------

  /**
   * Called from IngestionService.extractTripSegment for every travel-domain email. Two responsibilities,
   * in order:
   *
   * 1. CAL-004-style reconciliation: if this looks like a second email about a segment already on file
   *    (same confirmation number, or same provider+kind within a few days of the stored date), update
   *    that segment in place instead of creating a sibling — and this is also where TRIP-009 disruption
   *    detection happens (an explicit cancellation/delay statement, or a materially different schedule).
   *
   * 2. Otherwise, cluster: find EXISTING trips whose date range (± a couple of days) and destination
   *    overlap this segment. Precision-first, same stance as this session's other dedup/matching logic —
   *    auto-attach ONLY when exactly one candidate matches. Zero candidates creates a new trip normally;
   *    more than one candidate ALSO creates a new trip (never guesses which one), but records the
   *    ambiguous candidates on it so the UI can prompt the user to confirm a merge (`POST /v1/trips/:id/merge`).
   */
  async clusterSegment(seg: IncomingTripSegment): Promise<{ tripId: string; segmentId: string; isNewSegment: boolean; isNewTrip: boolean }> {
    const existing = await this.findExistingSegment(seg);
    if (existing) {
      await this.reconcileSegment(existing, seg);
      return { tripId: existing.tripId, segmentId: existing.id, isNewSegment: false, isNewTrip: false };
    }

    const candidates = await this.findClusterCandidateTrips(seg);
    let tripId: string;
    let isNewTrip = false;
    if (candidates.length === 1) {
      tripId = candidates[0]!.id;
      await this.expandTripRange(tripId, seg.startAtSort, seg.endAtSort, seg.destinationCityOrRegion);
    } else {
      isNewTrip = true;
      tripId = await this.createTripForSegment(seg, candidates.length > 1 ? candidates.map((c) => c.id) : []);
    }

    const segmentId = generateId("tripSegment");
    await this.db.insert(schema.tripSegments).values({
      id: segmentId,
      tripId,
      ownerUserId: seg.ownerUserId,
      kind: seg.kind,
      providerName: seg.providerName,
      confirmationNumber: seg.confirmationNumber,
      locationLabel: seg.locationLabel,
      startAt: seg.startAt,
      startAtSort: seg.startAtSort,
      endAt: seg.endAt,
      endAtSort: seg.endAtSort,
      detailsJson: seg.detailsJson,
      cancellationDeadline: seg.cancellationDeadline,
      cancellationDeadlineSort: seg.cancellationDeadlineSort,
      policyEvidenceText: seg.policyEvidenceText,
      confidenceBand: seg.confidenceBand,
      sourceEventId: seg.sourceEventId,
    });
    await this.ensurePackingList(tripId, seg.ownerUserId, seg.householdId, seg.kind);
    return { tripId, segmentId, isNewSegment: true, isNewTrip };
  }

  /** Precision-first fallback dedup, mirroring findExistingBill/findExistingDiscoveredCalendarEvent's
   * "more than one candidate -> treat as no match" stance. A confirmation number is the strongest possible
   * signal (near-certain to be the same real-world reservation); without one on either side, falls back to
   * same provider + still-upcoming + within a few days of the stored date. */
  private async findExistingSegment(seg: IncomingTripSegment) {
    const upcomingCutoff = new Date(Date.now() - 86_400_000);
    const candidates = await this.db
      .select()
      .from(schema.tripSegments)
      .where(
        and(
          eq(schema.tripSegments.ownerUserId, seg.ownerUserId),
          eq(schema.tripSegments.kind, seg.kind),
          or(isNull(schema.tripSegments.startAtSort), gte(schema.tripSegments.startAtSort, upcomingCutoff))!,
        ),
      );
    const normalizedConfirmation = normalize(seg.confirmationNumber);
    if (normalizedConfirmation) {
      const byConfirmation = candidates.filter((c) => normalize(c.confirmationNumber) === normalizedConfirmation);
      if (byConfirmation.length === 1) return byConfirmation[0];
      if (byConfirmation.length > 1) return null; // ambiguous — never guess
    }
    const normalizedProvider = normalize(seg.providerName);
    if (!normalizedProvider) return null;
    const byProvider = candidates.filter((c) => {
      if (normalize(c.providerName) !== normalizedProvider) return false;
      if (!c.startAtSort || !seg.startAtSort) return false;
      return Math.abs(c.startAtSort.getTime() - seg.startAtSort.getTime()) <= 3 * 86_400_000;
    });
    return byProvider.length === 1 ? byProvider[0] : null;
  }

  private async reconcileSegment(existing: typeof schema.tripSegments.$inferSelect, seg: IncomingTripSegment): Promise<void> {
    const updates: Partial<typeof schema.tripSegments.$inferInsert> = {
      startAt: seg.startAt ?? existing.startAt,
      startAtSort: seg.startAtSort ?? existing.startAtSort,
      endAt: seg.endAt ?? existing.endAt,
      endAtSort: seg.endAtSort ?? existing.endAtSort,
      locationLabel: seg.locationLabel ?? existing.locationLabel,
      cancellationDeadline: seg.cancellationDeadline ?? existing.cancellationDeadline,
      cancellationDeadlineSort: seg.cancellationDeadlineSort ?? existing.cancellationDeadlineSort,
      policyEvidenceText: seg.policyEvidenceText ?? existing.policyEvidenceText,
      updatedAt: new Date(),
    };

    // TRIP-009 disruption mode — the only "reliable source" available without a live airline/status feed
    // (see docs/PHASE3_PENDING_CREDENTIALS.md) is the email itself: an explicit cancellation/delay
    // statement, or a materially different schedule than what was already on file.
    if (seg.cancellationMentioned === true) {
      updates.status = "cancelled";
      updates.disruptionStatus = "cancelled";
      updates.disruptionNote = "A cancellation notice was received for this reservation.";
      updates.disruptionDetectedAt = new Date();
    } else if (seg.delayMentioned === true) {
      updates.disruptionStatus = "delayed";
      updates.disruptionNote = "A delay notice was received for this reservation.";
      updates.disruptionDetectedAt = new Date();
    } else if (existing.startAtSort && seg.startAtSort && Math.abs(existing.startAtSort.getTime() - seg.startAtSort.getTime()) > RESCHEDULE_THRESHOLD_MS) {
      updates.disruptionStatus = "changed";
      updates.disruptionNote = "The schedule changed from the original confirmation.";
      updates.disruptionDetectedAt = new Date();
    }

    await this.db.update(schema.tripSegments).set(updates).where(eq(schema.tripSegments.id, existing.id));
    if (seg.startAtSort || seg.endAtSort) await this.expandTripRange(existing.tripId, seg.startAtSort, seg.endAtSort, seg.destinationCityOrRegion);
  }

  private async findClusterCandidateTrips(seg: IncomingTripSegment) {
    if (!seg.startAtSort && !seg.endAtSort) return [];
    const trips = await this.db
      .select()
      .from(schema.trips)
      .where(and(eq(schema.trips.ownerUserId, seg.ownerUserId), isNull(schema.trips.deletedAt), or(eq(schema.trips.status, "upcoming"), eq(schema.trips.status, "active"))!));
    const normalizedDestination = normalize(seg.destinationCityOrRegion);
    return trips.filter(
      (t) => rangesOverlap(t.startDateSort, t.endDateSort, seg.startAtSort, seg.endAtSort, CLUSTER_DATE_TOLERANCE_MS) && destinationsMatch(normalize(t.destinationLabel), normalizedDestination),
    );
  }

  private async createTripForSegment(seg: IncomingTripSegment, ambiguousTripIds: string[]): Promise<string> {
    const id = generateId("trip");
    const label = seg.destinationCityOrRegion ? `Trip to ${seg.destinationCityOrRegion}` : seg.providerName ? `${seg.providerName} reservation` : "New trip";
    await this.db.insert(schema.trips).values({
      id,
      ownerUserId: seg.ownerUserId,
      householdId: seg.householdId,
      label,
      destinationLabel: seg.destinationCityOrRegion,
      startDate: seg.startAt,
      startDateSort: seg.startAtSort,
      endDate: seg.endAt ?? seg.startAt,
      endDateSort: seg.endAtSort ?? seg.startAtSort,
      travelerUserIds: [seg.ownerUserId],
      suggestedMergeTripIds: ambiguousTripIds,
    });
    await this.searchIndex?.upsert({
      resourceType: "trip",
      resourceId: id,
      ownerUserId: seg.ownerUserId,
      householdId: seg.householdId,
      sensitivity: "sensitive",
      title: label,
      bodyText: seg.destinationCityOrRegion ?? "",
    });
    return id;
  }

  private async expandTripRange(tripId: string, startAtSort: Date | null, endAtSort: Date | null, destinationCityOrRegion: string | null): Promise<void> {
    const [trip] = await this.db.select().from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1);
    if (!trip) return;
    const updates: Partial<typeof schema.trips.$inferInsert> = { updatedAt: new Date() };
    if (startAtSort && (!trip.startDateSort || startAtSort < trip.startDateSort)) updates.startDateSort = startAtSort;
    if (endAtSort && (!trip.endDateSort || endAtSort > trip.endDateSort)) updates.endDateSort = endAtSort;
    const merged = mergeDestinationLabels(trip.destinationLabel, destinationCityOrRegion);
    if (merged !== trip.destinationLabel) updates.destinationLabel = merged;
    if (Object.keys(updates).length > 1) await this.db.update(schema.trips).set(updates).where(eq(schema.trips.id, tripId));
  }
}

/** Multi-city support (spec's own "Multi-city" edge case) — appends a new city rather than replacing the
 * original, capped so an unusual number of distinct cities doesn't grow this field unboundedly. */
function mergeDestinationLabels(existing: string | null, incoming: string | null): string | null {
  if (!incoming) return existing;
  if (!existing) return incoming;
  const parts = existing.split(" / ").map((p) => p.trim());
  if (parts.some((p) => destinationsMatch(normalize(p), normalize(incoming)))) return existing;
  if (parts.length >= 4) return existing;
  return `${existing} / ${incoming}`;
}
