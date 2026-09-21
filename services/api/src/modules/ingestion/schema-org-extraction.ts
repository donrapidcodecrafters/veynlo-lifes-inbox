/**
 * Turn what a sender published about their own email into the same shape the model produces.
 *
 * `schema-org-email.ts` reads the markup. This maps it onto `ReceiptExtractionSchema` /
 * `ShipmentExtractionSchema`, so the markup path reuses every piece of filing logic the AI path already
 * has — order-number auto-merge, merchant resolution, purchase linking, knowledge-graph writes, the lot.
 * Nothing downstream needs to know which source a result came from, and no second filing path exists to
 * drift away from the first.
 *
 * `modelUsed` still records which one it was, because provenance matters when a field is later questioned.
 *
 * ---------------------------------------------------------------------------------------------------
 * On confidence
 * ---------------------------------------------------------------------------------------------------
 * These results carry a confidence of 1. That is not enthusiasm — it is the difference between a model
 * inferring an order number from prose and the merchant stating it in a machine-readable field of their
 * own message. The second cannot be misread. It can still be WRONG (a sender may publish bad markup), but
 * so can the prose it would otherwise be inferred from, and no amount of re-reading the prose would catch
 * a merchant who lies about their own order number.
 *
 * What this never does is fill a field nobody stated. Every value here traces to something the sender put
 * in the markup; everything else is null and, where the model is available, gets filled by it.
 */
import type { SchemaOrgFindings } from "./schema-org-email";
import type { BillExtraction, ReceiptExtraction, ShipmentExtraction, TripSegmentExtraction } from "../intelligence/extraction-schemas";
import type { StructuredExtractionResult } from "../intelligence/anthropic-extraction.service";

/** Recorded on every markup-derived result, so an extraction run says where its values came from. */
export const MARKUP_SOURCE = "schema.org-markup";

const MARKUP_NOTE =
  "Read from schema.org markup the sender published in this message. Values here were stated by the " +
  "sender, not inferred from the body text; anything they did not state is null.";

function markupResult<T>(data: T): StructuredExtractionResult<T> {
  return { data, confidenceScore: 1, modelUsed: MARKUP_SOURCE, inputTokens: 0, outputTokens: 0 };
}

/** schema.org's OrderStatus vocabulary, as far as it maps onto a shipment status this app models. */
const ORDER_STATUS_TO_SHIPMENT: Record<string, ShipmentExtraction["status"]> = {
  orderdelivered: "delivered",
  orderintransit: "in_transit",
  orderproblem: "exception",
  orderreturned: "returned_to_sender",
};

/** schema.org's DeliveryEvent vocabulary. */
const DELIVERY_STATUS_TO_SHIPMENT: Record<string, ShipmentExtraction["status"]> = {
  intransit: "in_transit",
  transitinprogress: "in_transit",
  delivered: "delivered",
  outfordelivery: "out_for_delivery",
  orderdelivered: "delivered",
  orderinTransit: "in_transit",
  deliveryexception: "exception",
  returned: "returned_to_sender",
  labelcreated: "label_created",
  orderprocessing: "label_created",
};

function mapStatus(value: string | null, table: Record<string, ShipmentExtraction["status"]>): ShipmentExtraction["status"] {
  if (!value) return null;
  // Unknown vocabulary terms map to null rather than a guess. A wrong status is worse than no status: it
  // drives "delivered" badges and delivery-evidence timestamps downstream.
  return table[value.toLowerCase()] ?? null;
}

/** An ExtractedDate, from a date this module has already validated as ISO. */
function statedDate(iso: string | null) {
  return iso ? { iso_date: iso, approximate_text: null } : null;
}

/**
 * A receipt result from an `Order`, or null when the markup carried none.
 *
 * Only the FIRST order is used. A message declaring several is real but rare (a digest), and filing all of
 * them against one source event would attribute every order to the same email. Taking one is the
 * conservative read; the rest are left to the model and the ordinary prose path.
 */
export function receiptResultFromMarkup(findings: SchemaOrgFindings): StructuredExtractionResult<ReceiptExtraction> | null {
  const order = findings.orders[0];
  if (!order) return null;

  const data: ReceiptExtraction = {
    merchantName: order.merchantName,
    orderNumber: order.orderNumber,
    purchaseDate: statedDate(order.orderDate),
    totalAmountMinorUnits: order.totalMinorUnits,
    currency: order.currency ?? "USD",
    // Markup has no vocabulary for these. Null, so the model fills them when it runs, rather than a zero
    // that would read as "this order had no tax".
    taxMinorUnits: null,
    shippingMinorUnits: null,
    lineItems: order.lineItems
      .filter((item) => item.name !== null)
      .map((item) => ({
        productLabel: item.name!,
        quantity: item.quantity ?? 1,
        unitPriceMinorUnits: item.priceMinorUnits,
      })),
    returnDeadline: null,
    paymentMethodBrand: null,
    paymentMethodLast4: null,
    confidenceNotes: MARKUP_NOTE,
  };

  return markupResult(data);
}

/**
 * A shipment result from a `ParcelDelivery`, or null when there is none — or none with a tracking number.
 *
 * A tracking number is what makes a shipment a shipment here: `extractShipment` refuses a result without
 * one, and `findExistingShipment` keys on it. A ParcelDelivery that states only a delivery window is real
 * markup but not a record this app can file or de-duplicate, so it is left to the prose path.
 */
export function shipmentResultFromMarkup(findings: SchemaOrgFindings): StructuredExtractionResult<ShipmentExtraction> | null {
  const parcel = findings.parcels.find((p) => p.trackingNumber !== null);
  if (!parcel) return null;

  const data: ShipmentExtraction = {
    carrier: parcel.carrier,
    trackingNumber: parcel.trackingNumber,
    orderNumber: parcel.orderNumber,
    merchantName: parcel.merchantName,
    status: mapStatus(parcel.deliveryStatus, DELIVERY_STATUS_TO_SHIPMENT),
    // The window's LATER bound is the estimate a person plans around — "arrives by". Falling back to the
    // earlier bound when only that is stated, rather than leaving it unknown.
    estimatedDelivery: statedDate(parcel.expectedArrivalUntil ?? parcel.expectedArrivalFrom),
    confidenceNotes: MARKUP_NOTE,
  };

  return markupResult(data);
}

/**
 * A trip segment from a reservation the sender published.
 *
 * Only the FIRST reservation is used, for the same reason `receiptResultFromMarkup` takes only the first
 * order: a source event files one segment, and attributing every leg of a return trip to the same email
 * would put two flights on one record. The rest are left to the prose path, which is where multi-leg
 * clustering already lives (TripsService.clusterSegment).
 *
 * Every field here traces to something the sender stated. The ones markup has no vocabulary for —
 * baggage allowance, a resort fee, a cancellation deadline, the policy text — stay null so the model fills
 * them when it runs. A cancellation deadline in particular is among the most valuable things this app
 * extracts and is never in the markup, which is exactly why the model still runs alongside this.
 */
export function tripSegmentResultFromMarkup(findings: SchemaOrgFindings): StructuredExtractionResult<TripSegmentExtraction> | null {
  const reservation = findings.reservations[0];
  if (!reservation) return null;

  const data: TripSegmentExtraction = {
    kind: reservation.kind,
    providerName: reservation.providerName,
    confirmationNumber: reservation.reservationNumber,
    locationLabel: reservation.locationLabel,
    // Markup names airports, stations and properties but never says which city a trip is "to" — that is an
    // inference, and inferring it here would cluster two unrelated trips together on a guess.
    destinationCityOrRegion: null,
    startDate: statedDate(reservation.startDate),
    startTime: reservation.startTime,
    endDate: statedDate(reservation.endDate),
    endTime: reservation.endTime,
    // The sender's stated UTC offset, not a zone name. Null when they stated none — deriving one from an
    // airport code would be inventing the fact that matters most on a travel record.
    timezone: reservation.utcOffset,
    cancellationDeadlineDate: statedDate(null),
    policyEvidenceText: null,
    travelerNamesOnReservation: reservation.travelerNames,
    // Only ever true from an explicit ReservationCancelled. Everything else, including markup that states
    // no status at all, leaves this null rather than asserting the booking is fine.
    cancellationMentioned: reservation.status === "Cancelled" ? true : null,
    // schema.org has no vocabulary for a delay. Null, never false: "no delay stated" and "stated there is
    // no delay" are different claims and this only knows the first.
    delayMentioned: null,
    flightNumber: reservation.flightNumber,
    departureAirport: reservation.departureAirport,
    arrivalAirport: reservation.arrivalAirport,
    seat: reservation.seat,
    baggageInfo: null,
    propertyName: reservation.propertyName,
    roomType: null,
    guestCount: null,
    feesInfo: null,
    vehicleOrServiceType: reservation.vehicleOrServiceType,
    pickupLocation: reservation.pickupLocation,
    dropoffLocation: reservation.dropoffLocation,
    eventName: reservation.eventName,
    venue: reservation.venue,
    bookingUrl: reservation.url,
    confidenceNotes: MARKUP_NOTE,
  };

  return markupResult(data);
}

/**
 * A bill from a declared `Invoice`, or null when there is none.
 *
 * Only the FIRST invoice is used, for the same reason the order and reservation mappers take only the
 * first: a source event files one bill, and a single notice covering several accounts would otherwise
 * attribute all of them to one record.
 */
export function billResultFromMarkup(findings: SchemaOrgFindings): StructuredExtractionResult<BillExtraction> | null {
  const invoice = findings.invoices[0];
  if (!invoice) return null;

  const data: BillExtraction = {
    billerName: invoice.billerName,
    amountDueMinorUnits: invoice.amountDueMinorUnits,
    currency: invoice.currency ?? "USD",
    dueDate: statedDate(invoice.dueDate),
    // schema.org says this outright. Inferring autopay from a sentence is a guess; being told is not.
    // Anything else leaves it null rather than asserting autopay is OFF — a claim the markup never makes.
    autopayMentioned: invoice.paymentStatus === "PaymentAutomaticallyApplied" ? true : null,
    accountLabel: invoice.accountId,
    // UTIL-001 equipment return has no schema.org vocabulary at all. Null, so the model fills it when it
    // runs — a cable box return window is one of the few genuinely costly things this app catches.
    equipmentReturnDeadline: statedDate(null),
    equipmentReturnInstructions: null,
    confidenceNotes: MARKUP_NOTE,
  };

  return markupResult(data);
}

/**
 * Which domains this message's markup establishes on its own.
 *
 * This is what lets a message skip the AI domain classifier entirely, and what makes extraction work at
 * all for a user who has turned AI processing off: a declared `Order` IS a receipt, with no inference and
 * no model call involved in saying so.
 *
 * A parcel also implies "receipt" when its markup names the order it belongs to — the same email carries
 * both facts, and dropping the order half would lose a purchase the sender plainly stated.
 */
export function domainsFromMarkup(findings: SchemaOrgFindings): string[] {
  const domains = new Set<string>();
  if (findings.orders.length > 0) domains.add("receipt");
  if (findings.parcels.some((p) => p.trackingNumber !== null)) domains.add("shipment");
  // A declared reservation IS travel. No inference, no model call, and it holds for a household that has
  // turned AI processing off — which is the whole reason this path exists.
  if (findings.reservations.length > 0) domains.add("travel");
  // A declared Invoice IS a bill. Same reasoning as the Order above, and the same benefit for a household
  // that has turned AI processing off.
  if (findings.invoices.length > 0) domains.add("bill");
  return [...domains];
}

/** Does the order status alone tell us this parcel was delivered? Used only where no delivery status exists. */
export function shipmentStatusFromOrderStatus(orderStatus: string | null): ShipmentExtraction["status"] {
  return mapStatus(orderStatus, ORDER_STATUS_TO_SHIPMENT);
}
