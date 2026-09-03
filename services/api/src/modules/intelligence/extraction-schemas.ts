import { z } from "zod";

/**
 * Stage-2 domain classifier output (§39.1). Multi-label allowed — a single
 * email can be both a purchase receipt and contain a warranty registration.
 */
export const DomainClassificationResultSchema = z.object({
  domains: z.array(
    z.enum([
      "receipt",
      "shipment",
      "bill",
      "subscription",
      "calendar_event",
      "travel",
      "warranty",
      "identity_document",
      "school",
      "home",
      "vehicle",
      "saved_item",
      "store_credit",
      "health_appointment",
      "pet",
      "irrelevant",
    ]),
  ),
  reasoning: z.string(),
});
export type DomainClassificationResult = z.infer<typeof DomainClassificationResultSchema>;

/** A date the model is not confident about must come back as `null`, never a fabricated guess (§AI-001/2, "No silent hallucination"). */
const ExtractedDateSchema = z
  .object({
    iso_date: z.string().nullable().describe("YYYY-MM-DD if a specific date is stated; null if unknown or only approximate"),
    approximate_text: z.string().nullable().describe("Original phrase if the date is only approximate, e.g. 'early next month'"),
  })
  .nullable();

export const ReceiptExtractionSchema = z.object({
  merchantName: z.string().nullable(),
  orderNumber: z.string().nullable(),
  purchaseDate: ExtractedDateSchema,
  totalAmountMinorUnits: z.number().int().nullable().describe("Total charged, in minor currency units (cents)"),
  currency: z.string().length(3).default("USD"),
  taxMinorUnits: z.number().int().nullable(),
  shippingMinorUnits: z.number().int().nullable(),
  lineItems: z.array(
    z.object({
      productLabel: z.string(),
      quantity: z.number().int().min(1).default(1),
      unitPriceMinorUnits: z.number().int().nullable(),
    }),
  ),
  returnDeadline: ExtractedDateSchema,
  confidenceNotes: z.string().describe("Anything ambiguous or uncertain about this extraction"),
});
export type ReceiptExtraction = z.infer<typeof ReceiptExtractionSchema>;

export const ShipmentExtractionSchema = z.object({
  carrier: z.string().nullable().describe("e.g. UPS, FedEx, USPS, Amazon Logistics"),
  trackingNumber: z.string().nullable(),
  orderNumber: z.string().nullable().describe("The retailer's order number, if mentioned, so this can be linked to its purchase"),
  merchantName: z.string().nullable(),
  status: z
    .enum(["label_created", "in_transit", "out_for_delivery", "delivered", "exception", "returned_to_sender", "lost"])
    .nullable(),
  estimatedDelivery: ExtractedDateSchema,
  confidenceNotes: z.string(),
});
export type ShipmentExtraction = z.infer<typeof ShipmentExtractionSchema>;

export const BillExtractionSchema = z.object({
  billerName: z.string().nullable(),
  amountDueMinorUnits: z.number().int().nullable(),
  currency: z.string().length(3).default("USD"),
  dueDate: ExtractedDateSchema,
  autopayMentioned: z.boolean().nullable(),
  accountLabel: z.string().nullable(),
  // UTIL-001 "equipment return obligations ... from source messages where available" — explicit-only, per
  // this schema's own no-hallucination rule (see the doc comment just above ExtractedDateSchema): null
  // unless the email literally states a hardware-return deadline (a cable box/modem/router return window
  // after cancellation or a plan change), never inferred from e.g. "this is your final bill" alone.
  equipmentReturnDeadline: ExtractedDateSchema,
  equipmentReturnInstructions: z.string().nullable().describe("The literal return instructions/address/RMA quoted from the email, verbatim; null if no equipment return is mentioned at all"),
  confidenceNotes: z.string(),
});
export type BillExtraction = z.infer<typeof BillExtractionSchema>;

export const CalendarEventExtractionSchema = z.object({
  title: z.string(),
  startDate: ExtractedDateSchema,
  startTime: z.string().nullable().describe("HH:MM 24-hour, in the timezone below, null if only a date is known"),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  isAllDay: z.boolean().default(false),
  confidenceNotes: z.string(),
});
export type CalendarEventExtraction = z.infer<typeof CalendarEventExtractionSchema>;

export const SubscriptionExtractionSchema = z.object({
  serviceLabel: z.string().nullable().describe("The subscribed service's name, e.g. 'Netflix', 'New York Times digital'"),
  merchantName: z.string().nullable(),
  cadence: z.enum(["weekly", "monthly", "quarterly", "annual", "irregular"]).nullable(),
  amountMinorUnits: z.number().int().nullable().describe("The recurring charge amount, in minor currency units (cents)"),
  currency: z.string().length(3).default("USD"),
  nextBillingDate: ExtractedDateSchema,
  isTrial: z.boolean().nullable().describe("True if this email is about a free trial, not a paid renewal"),
  trialEndsDate: ExtractedDateSchema,
  cancellationInstructionsUrl: z.string().nullable(),
  confidenceNotes: z.string(),
});
export type SubscriptionExtraction = z.infer<typeof SubscriptionExtractionSchema>;

export const WarrantyExtractionSchema = z.object({
  productLabel: z.string().nullable(),
  warrantyLengthMonths: z.number().int().nullable(),
  warrantyExpirationDate: ExtractedDateSchema,
  registrationConfirmed: z.boolean().nullable(),
  confidenceNotes: z.string(),
});
export type WarrantyExtraction = z.infer<typeof WarrantyExtractionSchema>;

/**
 * §25 "School, Children & Activities" (SCH-001). `matchedChildDisplayName` is deliberately constrained to
 * an exact copy of one name from the household-dependents list the prompt supplies (see
 * `IngestionService.extractSchool`'s system prompt) — never a freeform guess — and must be `null` whenever
 * the source text doesn't clearly single out one child, per spec's "avoids guessing child identity when
 * multiple candidates exist." `prepInstructions` must only contain instructions LITERALLY stated in the
 * source text (e.g. "bring a sack lunch", "wear your team jersey") — never a generic/inferred checklist;
 * an AI-generic suggestion is a client-side-only "Suggested" affordance, never written here or persisted
 * as a fact (see `SchoolService`'s own doc comment).
 */
export const SchoolExtractionSchema = z.object({
  schoolName: z.string().nullable().describe("The school/district/team name, if stated"),
  title: z.string().describe("A short label for this event/notice, e.g. 'No school - teacher in-service day'"),
  eventKind: z.enum([
    "no_school",
    "picture_day",
    "permission_deadline",
    "conference",
    "field_trip",
    "fee_due",
    "game",
    "practice",
    "announcement",
    "other",
  ]),
  eventDate: ExtractedDateSchema,
  eventTime: z.string().nullable().describe("HH:MM 24-hour, in the timezone below, null if only a date is known"),
  timezone: z.string().nullable(),
  isAllDay: z.boolean().default(true),
  location: z.string().nullable(),
  arrivalNote: z.string().nullable().describe("A short arrival/logistics note if explicitly stated, e.g. 'arrive by 5:45pm'"),
  matchedChildDisplayName: z.string().nullable().describe("Exact copy of one name from the supplied household-children list, or null if unclear/ambiguous/not applicable"),
  formTitle: z.string().nullable().describe("If this email is about a permission slip/form requiring signature, upload, or payment, its title — otherwise null"),
  formDueDate: ExtractedDateSchema,
  feeAmountMinorUnits: z.number().int().nullable().describe("A stated fee/payment amount in minor currency units, if this event has one (e.g. field trip fee)"),
  prepInstructions: z.array(z.string()).describe("Instructions to bring/wear/prepare something, ONLY if literally stated in the source text — never inferred or generic"),
  confidenceNotes: z.string(),
});
export type SchoolExtraction = z.infer<typeof SchoolExtractionSchema>;

/** Phase 2 §52.2 "store credits" — a balance owed BY a merchant TO the user (the inverse of a bill), e.g. "we issued a $45 store credit instead of a refund to your card." */
export const StoreCreditExtractionSchema = z.object({
  merchantName: z.string().nullable(),
  amountMinorUnits: z.number().int().nullable(),
  currency: z.string().length(3).default("USD"),
  expirationDate: ExtractedDateSchema,
  confidenceNotes: z.string(),
});
export type StoreCreditExtraction = z.infer<typeof StoreCreditExtractionSchema>;

/**
 * Phase 3 §26 "Travel & Reservations" (TRIP-002..005). One schema for all four reservation kinds
 * (flight/lodging/rental/ticket) — mirrors `tripSegments`'s own "one table, a kind discriminator" schema
 * design (see packages/db/src/schema/travel.ts's module doc comment): the common fields (provider,
 * confirmation, location, start/end, cancellation policy) apply to every kind, and the kind-specific
 * fields below are simply left null by the model for kinds they don't apply to, rather than needing four
 * separate extraction schemas/prompts. `travelerNamesOnReservation` and `destinationCityOrRegion` exist
 * specifically to feed TripsService's clustering match (date range + destination + traveler names), not
 * for display — TRIP-001 "asks when confidence is weak" depends on this being literal, not inferred.
 */
export const TripSegmentExtractionSchema = z.object({
  kind: z.enum(["flight", "lodging", "rental", "ticket"]),
  providerName: z.string().nullable().describe("Airline / hotel chain / rental company / ticket-and-event provider, exactly as stated"),
  confirmationNumber: z.string().nullable(),
  locationLabel: z.string().nullable().describe("e.g. 'JFK -> LHR', a hotel's address, a rental pickup city, or an event venue"),
  destinationCityOrRegion: z.string().nullable().describe("The city/region/country this segment is in or headed to — used to cluster segments into the same trip"),
  startDate: ExtractedDateSchema,
  startTime: z.string().nullable().describe("HH:MM 24-hour, in the timezone below, null if only a date is known"),
  endDate: ExtractedDateSchema,
  endTime: z.string().nullable(),
  timezone: z.string().nullable(),
  cancellationDeadlineDate: ExtractedDateSchema,
  policyEvidenceText: z.string().nullable().describe("The literal cancellation/change/refund policy text from the email, verbatim — never paraphrased or invented; null if no policy is stated"),
  travelerNamesOnReservation: z.array(z.string()).describe("Names of travelers listed on this reservation, exactly as stated in the email — used to cluster segments into the same trip, never inferred"),
  // TRIP-009 disruption mode — the only "reliable source" this app has for a disruption today is the
  // email itself explicitly saying so (see IngestionService.extractTripSegment's CAL-004-style
  // reconciliation, and docs/PHASE3_PENDING_CREDENTIALS.md for why there's no live flight-status feed).
  // Both default to false-ish via `.nullable()`, never true unless the email literally states it.
  cancellationMentioned: z.boolean().nullable().describe("True only if this email explicitly states the reservation/flight/booking has been CANCELLED"),
  delayMentioned: z.boolean().nullable().describe("True only if this email explicitly states a DELAY (e.g. a flight delay notice), not just a schedule change"),
  // Flight-specific
  flightNumber: z.string().nullable(),
  departureAirport: z.string().nullable(),
  arrivalAirport: z.string().nullable(),
  seat: z.string().nullable(),
  // TRIP-002 — free text, e.g. "1 checked bag, seat 14C" or "Carry-on only". Null unless the email
  // LITERALLY states a baggage allowance/count — never inferred from the fare class or airline's general
  // policy.
  baggageInfo: z.string().nullable().describe("Baggage allowance/count exactly as stated in the email (e.g. '1 checked bag, seat 14C') — null if not explicitly stated, never inferred from fare class or airline policy"),
  // Lodging-specific
  propertyName: z.string().nullable(),
  roomType: z.string().nullable(),
  guestCount: z.number().int().nullable(),
  // TRIP-003 — free text or a plainly-stated amount, e.g. "$25/night resort fee" or "Pet fee: $75". Null
  // unless the email literally states a fee — never inferred from the property/chain's general fee policy.
  feesInfo: z.string().nullable().describe("A resort/cleaning/pet/parking fee exactly as stated in the email — null if not explicitly stated, never inferred from the property's general policy"),
  // Rental/ground-transportation-specific
  vehicleOrServiceType: z.string().nullable().describe("e.g. 'Compact car', 'Amtrak Acela', 'Airport parking'"),
  pickupLocation: z.string().nullable(),
  dropoffLocation: z.string().nullable(),
  // Ticket-specific (concerts/sports/attractions/restaurants/appointments)
  eventName: z.string().nullable(),
  venue: z.string().nullable(),
  // TRIP-005 — the original provider/booking-page URL, when the email actually contains one (e.g. a
  // "Manage booking" / "View your ticket" link). Never fabricated — this is the safe, provider-terms-
  // respecting alternative to attempting to render a barcode/ticket image (see TripsService's own doc
  // comment on this field for why).
  bookingUrl: z.string().nullable().describe("The literal URL from a 'view/manage your booking', 'view ticket', or similar link in the email — null if no such URL is present"),
  confidenceNotes: z.string(),
});
export type TripSegmentExtraction = z.infer<typeof TripSegmentExtractionSchema>;

/**
 * §29.1 SAVE-002 "Automatic classification" — the twelve categories are the spec's own enumerated list
 * verbatim (product, place, recipe, article, movie/show, gift idea, event, trip idea, how-to, reference,
 * document, generic). `relatedPersonLabel` exists specifically to power SAVE-004's "gift ideas surface
 * before a chosen person's birthday" — a free-text name (e.g. "Dad"), matched by MemoriesService against a
 * household dependent's display name, never resolved to an entity id by the model itself (see
 * saved_memories.relatedPersonLabel's own schema doc comment for why). `suggestedTitle` is only ever a
 * FALLBACK the caller applies when the user left the title blank at save time — never overwrites a
 * user-provided title (§AI rule: AI enrichment never silently overwrites a user's own input).
 */
export const MemoryClassificationSchema = z.object({
  category: z.enum([
    "product",
    "place",
    "recipe",
    "article",
    "movie_show",
    "gift_idea",
    "event",
    "trip_idea",
    "how_to",
    "reference",
    "document",
    "generic",
  ]),
  confidence: z.number().min(0).max(1),
  suggestedTitle: z.string().nullable().describe("A short, human-readable title inferred from the content — null if none can be confidently inferred"),
  relatedPersonLabel: z
    .string()
    .nullable()
    .describe("If this is a gift idea or otherwise clearly meant for a specific person (e.g. 'Dad', 'Mom', a first name), that label exactly as it appears; otherwise null"),
  priceMinorUnits: z.number().int().nullable().describe("A stated price, in minor currency units (cents), if this is a product/service with one"),
  currency: z.string().length(3).nullable(),
  locationLabel: z.string().nullable().describe("A city/place/destination name, if this is a place, restaurant, or trip idea"),
  confidenceNotes: z.string(),
});
export type MemoryClassification = z.infer<typeof MemoryClassificationSchema>;

/**
 * §27 "Health Logistics (Non-Diagnostic)" (HLTH-001). The chapter's own boundary, quoted verbatim in this
 * module's callers: "Life Inbox may help users remember and organize healthcare logistics. It must not
 * quietly evolve into diagnosis, clinical triage, medication dosing advice, or an electronic medical record
 * ... without a separately designed clinical-safety, legal, privacy, and compliance program." This schema
 * is the concrete enforcement of that line at the data-shape level, mirroring `SchoolExtractionSchema`'s
 * `prepInstructions` discipline: every field here is a scheduling/logistics fact (who/where/when/what
 * document), never a symptom, condition, diagnosis, medication dose, or treatment plan — there is
 * deliberately no field this schema *could* fill with clinical content even if the model tried, since
 * `IngestionService.extractHealthAppointment`'s prompt is the first layer and this schema's shape is the
 * second, structural one (the model can't emit a field that doesn't exist).
 */
export const HealthAppointmentExtractionSchema = z.object({
  providerName: z.string().nullable().describe("The doctor/clinic/practice name exactly as stated — never a specialty inferred from context"),
  // A plain scheduling category, not a reason for the visit or a symptom — "dental"/"vision"/"therapy"/
  // "primary care"/"lab work" are logistics labels (which front desk to check in at), the same way
  // "flight" vs "lodging" is a logistics kind on TripSegmentExtractionSchema, not medical information.
  appointmentType: z.string().nullable().describe("A short logistics category only, e.g. 'dental', 'vision', 'physical therapy', 'primary care', 'lab work' — never a reason for visit, symptom, or diagnosis"),
  startDate: ExtractedDateSchema,
  startTime: z.string().nullable().describe("HH:MM 24-hour, in the timezone below, null if only a date is known"),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  // HLTH-001 "prep instructions only when sourced" — must be null whenever the source text doesn't
  // literally spell out a preparation step. Never fill this with a typical/generic instruction for this
  // appointment type (e.g. never infer "fast for 12 hours" just because appointmentType is "lab work") —
  // that would be exactly the "clinical inference" the chapter's boundary forbids.
  prepInstructions: z.string().nullable().describe("ONLY if the source text explicitly and literally states a pre-appointment instruction (e.g. 'fast for 8 hours before your appointment', 'bring your insurance card and a photo ID'). Never infer, guess, or supply a typical/generic instruction for this appointment type — leave null if nothing is explicitly stated."),
  confidenceNotes: z.string(),
});
export type HealthAppointmentExtraction = z.infer<typeof HealthAppointmentExtractionSchema>;

/**
 * PET-002 "vet/grooming appointments" — the same non-clinical logistics shape
 * `HealthAppointmentExtractionSchema` enforces for human appointments (this chapter shares the identical
 * "logistics, not diagnosis" boundary — see `IngestionService.extractPetEvent`'s system prompt). `petNameHint`
 * is deliberately just a hint, never a resolved id: `extractPetEvent` only auto-assigns the event to an
 * existing pet on an exact, case-insensitive name match when the household has exactly one pet with that
 * name — any ambiguity (multiple similarly-named pets, no match, no name mentioned at all) files the event
 * unassigned rather than guessing, the same "don't guess" discipline `SchoolExtractionSchema`'s child-name
 * matching already uses.
 */
export const PetEventExtractionSchema = z.object({
  petNameHint: z.string().nullable().describe("The pet's name exactly as stated in the source text, if any — never inferred or guessed"),
  title: z.string(),
  eventType: z.string().nullable().describe("A short logistics category only, e.g. 'vet checkup', 'grooming', 'boarding drop-off' — never a medical reason for the visit"),
  providerName: z.string().nullable().describe("The vet clinic/groomer name exactly as stated"),
  startDate: ExtractedDateSchema,
  startTime: z.string().nullable().describe("HH:MM 24-hour, in the timezone below, null if only a date is known"),
  timezone: z.string().nullable(),
  location: z.string().nullable(),
  confidenceNotes: z.string(),
});
export type PetEventExtraction = z.infer<typeof PetEventExtractionSchema>;

/**
 * PET-004 "vaccination/license records" — spec's own line: "Deadline must be sourced/user-confirmed." This
 * schema only ever produces an *evidence-sourced candidate* (see `IngestionService.extractPetVaccination`),
 * which is then filed through the normal inbox confirm/correct/dismiss flow exactly like every other
 * AI-discovered fact in this app (warranty, bill, calendar event, ...) — never written straight into
 * `petVaccinations` as an already-confirmed deadline. `petNameHint` carries the same conservative,
 * never-auto-resolved matching discipline as `PetEventExtractionSchema.petNameHint` above.
 */
export const PetVaccinationExtractionSchema = z.object({
  petNameHint: z.string().nullable().describe("The pet's name exactly as stated in the source text, if any — never inferred or guessed"),
  label: z.string().nullable().describe("The vaccine or license type exactly as stated, e.g. 'Rabies', 'City dog license'"),
  expirationDate: ExtractedDateSchema,
  confidenceNotes: z.string(),
});
export type PetVaccinationExtraction = z.infer<typeof PetVaccinationExtractionSchema>;

/**
 * MSG-001 "Share-message extraction" — "Shared message/text screenshot is classified for date, task,
 * event, address, purchase, recommendation, person or note." This is a DIFFERENT category set from
 * `DomainClassificationResultSchema` above (that one is tuned for email-shaped content — receipt/bill/
 * subscription/etc. — and has no "task"/"address"/"person"/"note"/"recommendation" domain at all; a
 * share-sheet capture of a text message fragment routed through the email classifier would silently land
 * on "irrelevant" or a dead-end domain like "saved_item" with nothing ever filed). Single-label, unlike the
 * email classifier — a share is one deliberate fragment the user is sending in "for" one reason, not a
 * multi-topic email that can legitimately be several things at once.
 *
 * Deliberately has NO field for asserting who sent the shared message. MSG-001's own line: "avoids
 * pretending sender identity is verified unless contact metadata/source supports it" — a share-sheet
 * capture (from any messaging app) carries no real contact/sender metadata Veynlo can verify, so the
 * schema simply has no slot the model could fill with a fabricated "from" claim; `personMentioned` below
 * is explicitly scoped to a person named INSIDE the content (e.g. "ask Jake to grab milk"), never who
 * shared it. This is the same "schema shape is the structural second layer" discipline this codebase
 * already uses elsewhere (see `HealthAppointmentExtractionSchema`'s own doc comment).
 */
export const ShareMessageCategorySchema = z.enum(["date", "task", "event", "address", "purchase", "recommendation", "person", "note"]);
export type ShareMessageCategory = z.infer<typeof ShareMessageCategorySchema>;

export const ShareMessageClassificationSchema = z.object({
  category: ShareMessageCategorySchema,
  confidence: z.number().min(0).max(1),
  title: z.string().nullable().describe("A short, human-readable title/summary of what was shared"),
  dateIso: z.string().nullable().describe("YYYY-MM-DD if a specific date is clearly stated; null if unknown, ambiguous, or only approximate (e.g. sarcasm, 'someday')"),
  taskDescription: z.string().nullable().describe("What needs to be done, if this is a task/reminder — exactly as stated, never elaborated"),
  addressText: z.string().nullable().describe("A physical address or specific place name mentioned, if any"),
  personMentioned: z
    .string()
    .nullable()
    .describe("A person's name mentioned WITHIN the shared content (e.g. 'call Jake back') — never a claim about who sent or forwarded this message, which cannot be verified from shared text/screenshot content alone"),
  noteText: z.string().nullable().describe("The gist of the content, for a general note or recommendation — a faithful short paraphrase, never embellished"),
  reasoning: z.string(),
});
export type ShareMessageClassification = z.infer<typeof ShareMessageClassificationSchema>;
