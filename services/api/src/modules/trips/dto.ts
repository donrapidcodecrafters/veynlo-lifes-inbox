import { z } from "zod";

/** TRIP-001 "Create trip from connected confirmations or MANUAL SEED" — the fallback path when no
 * ingested segment exists yet (or the user just wants to start planning ahead of any confirmation email). */
export const CreateTripDtoSchema = z.object({
  label: z.string().min(1).max(200).nullable().optional(),
  destinationLabel: z.string().min(1).max(200).nullable().optional(),
  startDateIso: z.string().nullable().optional(),
  endDateIso: z.string().nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreateTripDto = z.infer<typeof CreateTripDtoSchema>;

export const UpdateTripDtoSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  status: z.enum(["upcoming", "active", "completed", "cancelled"]).optional(),
});
export type UpdateTripDto = z.infer<typeof UpdateTripDtoSchema>;

/** TRIP-001 "add/remove traveler" user action — scoped to real Veynlo accounts, same reasoning as
 * `trips.travelerUserIds`'s own schema doc comment. */
export const SetTripTravelerDtoSchema = z.object({
  travelerUserId: z.string().min(1),
});
export type SetTripTravelerDto = z.infer<typeof SetTripTravelerDtoSchema>;

/** TRIP-001 "Confirm trip merge" — the explicit, user-initiated resolution of an ambiguous clustering
 * candidate (see `trips.suggestedMergeTripIds`'s doc comment). `sourceTripId` is merged INTO the trip in
 * the URL (`:id`) and then removed; never automatic. */
export const MergeTripsDtoSchema = z.object({
  sourceTripId: z.string().min(1),
});
export type MergeTripsDto = z.infer<typeof MergeTripsDtoSchema>;

/**
 * The kind-specific fields below mirror IngestionService.extractTripSegment's own `detailsJson` keys
 * exactly (see ingestion.service.ts's `extractTripSegment` and `tripSegments.detailsJson`'s own schema
 * doc comment) — a manually-entered segment should be able to record the same "airline/flight number/
 * seat" (flight), "property/room/guests" (lodging), "vehicle or service/pickup/dropoff" (rental), or
 * "event/venue" (ticket) detail an AI-extracted one can, not a strictly smaller set of fields. All
 * optional/nullable: a user filling this in by hand may not know every field, same "never require what
 * isn't known" stance as every other manual-entry DTO in this app.
 */
export const CreateManualTripSegmentDtoSchema = z.object({
  kind: z.enum(["flight", "lodging", "rental", "ticket"]),
  providerName: z.string().max(200).nullable().optional(),
  confirmationNumber: z.string().max(200).nullable().optional(),
  locationLabel: z.string().max(300).nullable().optional(),
  startDateIso: z.string().nullable().optional(),
  endDateIso: z.string().nullable().optional(),
  // flight
  flightNumber: z.string().max(30).nullable().optional(),
  departureAirport: z.string().max(120).nullable().optional(),
  arrivalAirport: z.string().max(120).nullable().optional(),
  seat: z.string().max(30).nullable().optional(),
  baggageInfo: z.string().max(300).nullable().optional(),
  // lodging
  propertyName: z.string().max(200).nullable().optional(),
  roomType: z.string().max(120).nullable().optional(),
  guestCount: z.number().int().min(1).max(50).nullable().optional(),
  feesInfo: z.string().max(300).nullable().optional(),
  // rental / ground transport
  vehicleOrServiceType: z.string().max(120).nullable().optional(),
  pickupLocation: z.string().max(200).nullable().optional(),
  dropoffLocation: z.string().max(200).nullable().optional(),
  // ticket
  eventName: z.string().max(200).nullable().optional(),
  venue: z.string().max(200).nullable().optional(),
  // any kind
  bookingUrl: z.string().max(500).nullable().optional(),
});
export type CreateManualTripSegmentDto = z.infer<typeof CreateManualTripSegmentDtoSchema>;

/** Manual entry — mirrors CommerceService's CreateStoreCreditDtoSchema shape, for a travel voucher/credit
 * with no cancelled segment behind it (e.g. a goodwill airline voucher issued outside this app's view). */
export const CreateTravelCreditDtoSchema = z.object({
  tripId: z.string().nullable().optional(),
  providerName: z.string().min(1).max(200).nullable().optional(),
  amountMinorUnits: z.number().int().positive(),
  currency: z.string().length(3).optional(),
  expirationDateIso: z.string().nullable().optional(),
});
export type CreateTravelCreditDto = z.infer<typeof CreateTravelCreditDtoSchema>;

/**
 * "Add calendar" trip-segment action — reuses ScheduleService.createEvent (see TripsService.
 * addSegmentToCalendar) rather than modeling a second, parallel event-creation path. `reminderMinutesBefore`
 * mirrors CreateEventDtoSchema/AddToCalendarDtoSchema's identical field/cap exactly, so this segment's
 * created event behaves like every other calendar event in the app once it exists.
 */
export const AddSegmentToCalendarDtoSchema = z.object({
  reminderMinutesBefore: z.number().int().min(0).max(4320).optional(),
});
export type AddSegmentToCalendarDto = z.infer<typeof AddSegmentToCalendarDtoSchema>;

/**
 * TRIP-002/TRIP-003 "Set check-in reminder" — see `tripSegments.checkInReminderMinutesBefore`'s own schema
 * doc comment for why this is its own field rather than a real `calendar_events` row. Same cap as every
 * other reminder-lead-time DTO in the app.
 */
export const SetSegmentCheckInReminderDtoSchema = z.object({
  checkInReminderMinutesBefore: z.number().int().min(0).max(4320).nullable(),
});
export type SetSegmentCheckInReminderDto = z.infer<typeof SetSegmentCheckInReminderDtoSchema>;
