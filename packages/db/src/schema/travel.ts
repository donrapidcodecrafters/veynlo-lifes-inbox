import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { visibilityEnum } from "./common";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

/**
 * Phase 3 §26 "Travel & Reservations" (spec TRIP-001..TRIP-009). Deliberately plain top-level tables
 * (not a `canonical_entities` subtype), same reasoning as `assets.ts`'s propertyProfiles/vehicleProfiles —
 * a trip is a first-class clustering object the app assembles/names, not a fact hanging off one piece of
 * ingested evidence.
 *
 * `trips` is deliberately thin: date range + destination + status + travelers. It does NOT store a
 * `disruptionStatus` rollup column — TRIP-009's "elevate relevant trip/segment" badge is computed at read
 * time from `tripSegments.disruptionStatus` (see TripsService.tripDetail/listTrips) rather than
 * duplicated/cached here, so there's no risk of that rollup going stale relative to the segments it
 * summarizes.
 */
export const trips = pgTable(
  "trips",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    // User-chosen or auto-derived (e.g. "Trip to Lisbon") — nullable until at least one segment/label exists.
    label: encryptedText("label"),
    destinationLabel: encryptedText("destination_label"),
    startDate: jsonb("start_date").$type<TemporalValue>(),
    startDateSort: timestamp("start_date_sort", { withTimezone: true }),
    endDate: jsonb("end_date").$type<TemporalValue>(),
    endDateSort: timestamp("end_date_sort", { withTimezone: true }),
    // "upcoming" | "active" | "completed" | "cancelled" — cancelled is a manual/derived state (every
    // segment cancelled), not something ingestion sets directly on the trip itself.
    status: text("status").notNull().default("upcoming"),
    // Household members traveling together; a non-account traveler (a child, a friend with no Veynlo
    // login) has no row here — TRIP-001's "add/remove traveler" user action is deliberately scoped to
    // real accounts for now, same precision-first stance as everywhere else this session: no invented
    // traveler identity.
    travelerUserIds: jsonb("traveler_user_ids").$type<string[]>().notNull().default([]),
    // HH-002-style privacy badge, same enum as documents/properties/vehicles — "household trip sharing can
    // exclude payment/ID evidence" (spec) is enforced in TripsService.publicShareContent, not by this column.
    visibility: visibilityEnum("visibility").notNull().default("private"),
    // FAM-005-style linkage — set once a packing list is auto-created for this trip (TRIP-008), so a
    // second segment clustering into the same trip doesn't spawn a second list.
    packingListId: text("packing_list_id"),
    // TRIP-001 "asks when confidence is weak" — precision-first clustering (see TripsService.clusterSegment)
    // only auto-attaches a new segment to an EXISTING trip when exactly one candidate trip overlaps by
    // date+destination. When more than one candidate overlaps (ambiguous — e.g. two separate trips to the
    // same city in the same season), a NEW trip is created for the segment rather than guessing, and the
    // ambiguous candidates are recorded here so the UI can prompt "did you mean to merge this with one of
    // these trips?" via the explicit `POST /v1/trips/:id/merge` action — never auto-merged.
    suggestedMergeTripIds: jsonb("suggested_merge_trip_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("trips_owner_idx").on(t.ownerUserId), index("trips_start_idx").on(t.startDateSort)],
);

/**
 * Polymorphic segment row — one table with a `kind` discriminator ("flight" | "lodging" | "rental" |
 * "ticket"), mirroring how `calendarEvents`/`purchases` already model "one table, a kind/source
 * discriminator column" rather than four near-identical segment-type tables (see this file's own module
 * doc comment / the Phase 3 design note that motivated it). Fields common to every kind (provider,
 * confirmation number, location, start/end, cancellation deadline, policy evidence, disruption state) are
 * real columns; kind-specific fields (flight number/seat/baggage; room/guest count and lodging fees;
 * rental pickup/dropoff; ticket/event name, venue, and a booking-page deep-link) live in `detailsJson` —
 * encrypted like every other free-text traveler detail on this table, and deliberately never queried by
 * path (see encryptedJsonb's own doc comment on why that's the one condition for using it).
 *
 * TRIP-002 `baggageInfo` (flight) and TRIP-003 `feesInfo` (lodging) are free text, populated ONLY when the
 * source email literally states it (e.g. "1 checked bag, seat 14C" / "$25/night resort fee") — never
 * inferred from the airline/property's general policy, same "never invent a fact not literally in the
 * source" discipline as `policyEvidenceText`. TRIP-005 `bookingUrl` (any kind, most useful on "ticket") is
 * the original provider/booking-page link when the email contains one — shown as a "View on [provider]"
 * deep-link-out rather than ever attempting to fabricate a barcode/ticket image, which would violate
 * provider terms this app doesn't have a license to reproduce.
 */
export const tripSegments = pgTable(
  "trip_segments",
  {
    id: text("id").primaryKey(),
    tripId: text("trip_id")
      .notNull()
      .references(() => trips.id, { onDelete: "cascade" }),
    // Denormalized alongside tripId (same reasoning as shipments.ownerUserId's own doc comment) — lets
    // clustering/dedup queries (findClusterCandidateTrips) and ownership checks avoid a join back through
    // trips for every candidate row.
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "flight" | "lodging" | "rental" | "ticket"
    providerName: encryptedText("provider_name"), // airline / hotel chain / rental company / ticket provider
    confirmationNumber: encryptedText("confirmation_number"),
    locationLabel: encryptedText("location_label"), // airport code(s) / hotel address / rental pickup city / venue
    startAt: jsonb("start_at").$type<TemporalValue>(),
    startAtSort: timestamp("start_at_sort", { withTimezone: true }),
    endAt: jsonb("end_at").$type<TemporalValue>(),
    endAtSort: timestamp("end_at_sort", { withTimezone: true }),
    // No `.default({})` here — encryptedJsonb columns don't get a working DB-level default (drizzle-kit's
    // migration generator stringifies the raw JS default for this text-backed custom type instead of
    // routing it through `toDriver`/`encryptField`, producing literally invalid SQL like
    // `DEFAULT [object Object]`; see documents.ts's `tags` column and migration 0003_daffy_mister_fear.sql,
    // which hit and fixed this exact bug by dropping the column default). Application code (extractTripSegment)
    // always passes `detailsJson` explicitly on insert, so there's no gap in practice.
    detailsJson: encryptedJsonb<Record<string, unknown>>("details_json", {}).notNull(),
    // TRIP-003 "cancellation policy source/evidence visible" — the deadline by which this segment can
    // still be cancelled/changed for free (or for the stated fee), plus the literal evidence text it was
    // read from (never fabricated — see extractTripSegment's system prompt).
    cancellationDeadline: jsonb("cancellation_deadline").$type<TemporalValue>(),
    cancellationDeadlineSort: timestamp("cancellation_deadline_sort", { withTimezone: true }),
    policyEvidenceText: encryptedText("policy_evidence_text"),
    status: text("status").notNull().default("confirmed"), // "confirmed" | "cancelled"
    // TRIP-009 disruption mode — "none" | "delayed" | "cancelled" | "changed". Set only by a real
    // reschedule/cancellation email reconciling against this exact segment (mirrors CAL-004's reschedule
    // reconciliation), never inferred from a live status feed this app has no integration for — see
    // docs/PHASE3_PENDING_CREDENTIALS.md.
    disruptionStatus: text("disruption_status").notNull().default("none"),
    disruptionNote: encryptedText("disruption_note"),
    disruptionDetectedAt: timestamp("disruption_detected_at", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    sourceEventId: text("source_event_id"),
    // TRIP-002/TRIP-003 "Set check-in reminder" — a plain integer column (not encrypted, not folded into
    // detailsJson) so AttentionService.scanAndFileDeadlines can scan it directly, mirroring
    // calendarEvents.reminderMinutesBefore's own column shape/doc comment exactly. Deliberately its OWN
    // field rather than reusing a real calendarEvents row: a trip segment doesn't get a calendar_events row
    // at all unless the user explicitly uses the "Add to calendar" action (see TripsService.
    // addSegmentToCalendar) — the reminder needs to work independent of whether that ever happens, and
    // reusing reminderMinutesBefore would have coupled two independently-deletable rows together for no
    // benefit. Null means "no check-in reminder set"; only meaningful for kind "flight"/"lodging" (a rental
    // or ticket has no "check-in" concept — see TripsService.setSegmentCheckInReminder's own guard), same
    // "not enforced at the schema level, enforced in the service" precedent as recurrenceRule being
    // event-only on calendarEvents.
    checkInReminderMinutesBefore: integer("check_in_reminder_minutes_before"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("trip_segments_trip_idx").on(t.tripId),
    index("trip_segments_owner_start_idx").on(t.ownerUserId, t.startAtSort),
  ],
);

/**
 * TRIP-007 "Cancellation and credit tracking" — deliberately its OWN table rather than reusing
 * `commerce.ts`'s `storeCredits`, even though the two shapes (amount/currency/expiration/redeemed) are
 * nearly identical: a travel credit is naturally scoped to a trip/segment (`tripId`/`sourceSegmentId`),
 * and bolting travel-specific FKs onto the generic commerce `storeCredits` table would couple the
 * commerce domain to travel for every future reader of that table. `AttentionService.scanAndFileDeadlines`
 * still reuses the exact same expiration-alert *pattern* (not the same table) it already applies to
 * `storeCredits`/`warranties` — see that method's `travelCredits` block.
 */
export const travelCredits = pgTable(
  "travel_credits",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    tripId: text("trip_id").references(() => trips.id, { onDelete: "set null" }),
    sourceSegmentId: text("source_segment_id").references(() => tripSegments.id, { onDelete: "set null" }),
    providerName: encryptedText("provider_name"), // airline/hotel that issued the voucher/credit
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    expirationDate: jsonb("expiration_date").$type<TemporalValue>(),
    expirationDateSort: timestamp("expiration_date_sort", { withTimezone: true }),
    sourceEventId: text("source_event_id"),
    redeemed: boolean("redeemed").notNull().default(false),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("travel_credits_owner_idx").on(t.ownerUserId), index("travel_credits_expiration_idx").on(t.expirationDateSort)],
);
