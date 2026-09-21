/**
 * Read the structured data retailers, airlines and hotels already put in their own emails.
 *
 * Gmail and Outlook both support schema.org markup embedded in an email's HTML — a
 * `<script type="application/ld+json">` block carrying an `Order`, `ParcelDelivery`,
 * `FlightReservation` or `LodgingReservation`. It is how "Track package" and "Check in" buttons appear on
 * a message without anyone reading the prose. Large senders emit it as a matter of course.
 *
 * Today this app ignores it completely. `parseGmailMessage` prefers `text/plain` and, failing that, strips
 * tags from the HTML — so the markup is either never seen or reduced to a smear of JSON in the middle of
 * the body text. Every one of those facts is then re-derived by asking a model to read the prose, which
 * costs money per message and can be wrong about something the sender stated exactly.
 *
 * This module does no inference. It reads what the sender declared, or returns nothing.
 *
 * ---------------------------------------------------------------------------------------------------
 * This input is hostile by construction
 * ---------------------------------------------------------------------------------------------------
 * Anyone who can send an email can put anything in this block. So:
 *
 *   - Every script block is size-bounded before parsing, and the number of blocks is bounded too. A
 *     100 MB JSON array in an email must cost a bounded amount of work, not a worker process.
 *   - Object depth is bounded during walking, because a deeply nested array is a stack overflow dressed
 *     as a receipt.
 *   - `__proto__` / `constructor` / `prototype` keys are dropped at parse time. `JSON.parse` itself does
 *     not pollute a prototype, but the objects it returns get walked, spread and merged downstream, and
 *     that is where it happens.
 *   - Every string that survives is length-clamped. These values reach a database and a screen.
 *   - Nothing here is ever treated as an instruction. These are values, not prompts — the same rule
 *     `SearchService`'s hardcoded prompt core exists to enforce on the model side.
 *
 * What this module does NOT do: decide anything. It reports what was declared. The caller decides whether
 * to trust it, what to do when it disagrees with the prose, and whether the sender is one whose markup is
 * worth believing.
 */

/** Bounds. Chosen to comfortably fit real markup while refusing anything pathological. */
const MAX_SCRIPT_BLOCKS = 20;
const MAX_BLOCK_BYTES = 256 * 1024;
const MAX_DEPTH = 12;
const MAX_STRING_LENGTH = 512;
const MAX_ITEMS_PER_TYPE = 50;
const MAX_ORDER_LINE_ITEMS = 100;

const SCRIPT_BLOCK = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Keys that must never survive into an object this app then spreads, merges or assigns from. */
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export interface SchemaOrgLineItem {
  name: string | null;
  quantity: number | null;
  priceMinorUnits: number | null;
  currency: string | null;
}

export interface SchemaOrgOrder {
  orderNumber: string | null;
  merchantName: string | null;
  orderDate: string | null;
  totalMinorUnits: number | null;
  currency: string | null;
  orderStatus: string | null;
  lineItems: SchemaOrgLineItem[];
  url: string | null;
}

export interface SchemaOrgParcel {
  trackingNumber: string | null;
  carrier: string | null;
  orderNumber: string | null;
  merchantName: string | null;
  expectedArrivalFrom: string | null;
  expectedArrivalUntil: string | null;
  deliveryStatus: string | null;
  trackingUrl: string | null;
}

/**
 * A reservation the sender published in their own confirmation email.
 *
 * Appendix A lists 23 travel targets — airlines, hotels, rail, car hire, ticketing — and every one of them
 * sat in the "served by the email pipeline" column, which in practice meant "a model reads the prose".
 * Reservation markup is the alternative the industry already standardised on and that Gmail has rendered
 * cards from for years. It costs no model call, it STATES the confirmation number rather than inferring
 * it, and it works for a household that has turned AI processing off entirely.
 */
export interface SchemaOrgReservation {
  /** Mapped onto this app's own four kinds, not schema.org's dozen. Rail and coach are ground transport. */
  kind: "flight" | "lodging" | "rental" | "ticket";
  reservationNumber: string | null;
  providerName: string | null;
  /** "Confirmed" | "Cancelled" | "Pending" | "Hold" — the bare token, not the full URL. */
  status: string | null;
  travelerNames: string[];
  startDate: string | null;
  /** HH:MM, 24-hour, exactly as stated. Null when the markup gave only a date. */
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  /** The UTC offset the sender stated, e.g. "-05:00". Never guessed from an airport or a city name. */
  utcOffset: string | null;
  url: string | null;
  locationLabel: string | null;
  flightNumber: string | null;
  departureAirport: string | null;
  arrivalAirport: string | null;
  seat: string | null;
  propertyName: string | null;
  vehicleOrServiceType: string | null;
  pickupLocation: string | null;
  dropoffLocation: string | null;
  eventName: string | null;
  venue: string | null;
}

export interface SchemaOrgFindings {
  orders: SchemaOrgOrder[];
  parcels: SchemaOrgParcel[];
  reservations: SchemaOrgReservation[];
  /** How many `<script type="application/ld+json">` blocks were seen, including ones that failed to parse. */
  blocksSeen: number;
  /** Blocks that were present but unusable — malformed JSON, or over the size bound. */
  blocksRejected: number;
}

export const EMPTY_FINDINGS: SchemaOrgFindings = Object.freeze({
  orders: [],
  parcels: [],
  reservations: [],
  blocksSeen: 0,
  blocksRejected: 0,
});

/** `JSON.parse` with the dangerous keys removed as the tree is built. */
function safeParse(text: string): unknown {
  return JSON.parse(text, function reviver(key, value) {
    if (FORBIDDEN_KEYS.has(key)) return undefined;
    return value;
  });
}

function clampString(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value).slice(0, MAX_STRING_LENGTH);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, MAX_STRING_LENGTH);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * schema.org's `@type` is routinely an array, and casing in the wild is inconsistent. Both are normalized
 * so a `["Order","Thing"]` or an `"order"` is recognized rather than silently skipped — silently skipping
 * would make this module look like it simply found nothing, which is the failure mode hardest to notice.
 */
function typesOf(node: Record<string, unknown>): string[] {
  const raw = node["@type"];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.filter((t): t is string => typeof t === "string").map((t) => t.toLowerCase().trim());
}

function isType(node: Record<string, unknown>, type: string): boolean {
  return typesOf(node).includes(type.toLowerCase());
}

/**
 * Money in schema.org is a string far more often than a number ("129.99"), and a `PriceSpecification`
 * wrapper is common. Returns integer minor units, or null — never a guess.
 *
 * Deliberately refuses anything with more than two decimal places rather than rounding it. A price stated
 * to four places is not a currency amount this app models, and quietly rounding it would invent a number
 * the sender did not state.
 */
function toMinorUnits(value: unknown): number | null {
  const raw = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : null;
  if (raw === null || raw === "") return null;
  // Strip a leading currency symbol and any thousands separators, but refuse anything else unexpected.
  const cleaned = raw.replace(/^[^\d\-+.]*/, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const asNumber = Number(cleaned);
  if (!Number.isFinite(asNumber)) return null;
  // Scale on the STRING, not by multiplying a float.
  //
  // Most amounts survive multiplication — 129.99 * 100 is exactly 12999 — which is what makes this worth
  // stating precisely rather than hand-waving: the ones that DON'T are unremarkable-looking values like
  // 1.15 (114.99999999999999) and 8.20 (819.9999999999999). Truncating either loses a cent, and a "round
  // it and hope" scaler is correct only until the first amount where it isn't. Scaling the decimal string
  // has no failure mode to reason about at all.
  const negative = cleaned.startsWith("-");
  const [whole, fraction = ""] = cleaned.replace(/^[-+]/, "").split(".");
  const minor = Number(`${whole}${fraction.padEnd(2, "0")}`);
  if (!Number.isSafeInteger(minor)) return null;
  return negative ? -minor : minor;
}

function currencyOf(node: Record<string, unknown> | null): string | null {
  if (!node) return null;
  const code = clampString(node.priceCurrency ?? node.currency);
  return code && /^[A-Za-z]{3}$/.test(code) ? code.toUpperCase() : null;
}

/** An ISO-8601 date or date-time, reduced to its date part. Anything else is dropped, never repaired. */
function toIsoDate(value: unknown): string | null {
  const raw = clampString(value);
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  if (!match) return null;
  const date = match[1]!;
  // Reject a syntactically valid but impossible date rather than storing it.
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

/**
 * An ISO-8601 date-time, split into the three parts this app stores separately.
 *
 * `toIsoDate` above deliberately throws the time away, which is right for an order date and wrong for a
 * departure: "2026-04-15" and "2026-04-15T18:30:00-05:00" are not the same fact, and a flight filed
 * without its time is a flight somebody can miss.
 *
 * The offset is taken ONLY when the sender stated one. A departure time with no zone is ambiguous, and
 * guessing a zone from an airport code would be inventing a fact — the caller resolves it the same way it
 * resolves any other unzoned time.
 */
function toIsoDateTime(value: unknown): { date: string | null; time: string | null; utcOffset: string | null } {
  const rawValue = clampString(value);
  if (!rawValue) return { date: null, time: null, utcOffset: null };
  const match = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?/.exec(rawValue);
  if (!match) return { date: null, time: null, utcOffset: null };

  const date = toIsoDate(match[1]);
  if (!date) return { date: null, time: null, utcOffset: null };

  const hour = match[2];
  const minute = match[3];
  let time: string | null = null;
  if (hour !== undefined && minute !== undefined) {
    const h = Number(hour);
    const m = Number(minute);
    // A syntactically valid but impossible time is dropped rather than stored or repaired.
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) time = `${hour}:${minute}`;
  }

  let utcOffset: string | null = null;
  const zone = match[4];
  if (zone === "Z") utcOffset = "+00:00";
  else if (zone) utcOffset = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone;

  return { date, time, utcOffset };
}

/** A place's name, however schema.org happened to express it — a string, a named node, or an address. */
function placeName(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return clampString(value);
  const named = clampString(record.name);
  if (named) return named;
  const address = asRecord(record.address);
  if (address) {
    const parts = [address.streetAddress, address.addressLocality, address.addressRegion, address.addressCountry]
      .map((part) => clampString(part))
      .filter((part): part is string => part !== null);
    if (parts.length > 0) return parts.join(", ").slice(0, MAX_STRING_LENGTH);
  }
  return clampString(record.address);
}

/** schema.org names an organization either as a bare string or as an `{ "@type": "Organization", name }`. */
function organizationName(value: unknown): string | null {
  const record = asRecord(value);
  if (record) return clampString(record.name);
  return clampString(value);
}

/**
 * Walk every node in a parsed block, yielding each object. Handles the three shapes real markup uses: a
 * bare object, a top-level array, and a `@graph` container. Depth-bounded.
 */
function* walk(value: unknown, depth = 0): Generator<Record<string, unknown>> {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const item of value) yield* walk(item, depth + 1);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  yield record;
  for (const key of Object.keys(record)) {
    // `@context` is boilerplate and never carries an entity.
    if (key === "@context") continue;
    yield* walk(record[key], depth + 1);
  }
}

function readLineItems(order: Record<string, unknown>): SchemaOrgLineItem[] {
  const raw = order.acceptedOffer ?? order.orderedItem;
  const list = Array.isArray(raw) ? raw : [raw];
  const items: SchemaOrgLineItem[] = [];

  for (const entry of list.slice(0, MAX_ORDER_LINE_ITEMS)) {
    const node = asRecord(entry);
    if (!node) continue;

    // An `Offer` wraps the product; an `orderedItem` may be the product directly.
    const offered = asRecord(node.itemOffered) ?? asRecord(node.orderedItem);
    const product = offered ?? node;

    const name = clampString(product.name);
    const quantityRaw = node.eligibleQuantity ?? node.orderQuantity ?? node.quantity;
    const quantityNode = asRecord(quantityRaw);
    const quantity = Number(clampString(quantityNode ? quantityNode.value : quantityRaw) ?? NaN);

    const priceSpec = asRecord(node.priceSpecification);
    const priceMinorUnits = toMinorUnits(priceSpec ? priceSpec.price : node.price);

    if (name === null && priceMinorUnits === null) continue; // nothing was actually stated
    items.push({
      name,
      quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : null,
      priceMinorUnits,
      currency: currencyOf(priceSpec) ?? currencyOf(node),
    });
  }

  return items;
}

function readOrder(node: Record<string, unknown>): SchemaOrgOrder | null {
  const priceSpec = asRecord(node.priceSpecification);
  const order: SchemaOrgOrder = {
    orderNumber: clampString(node.orderNumber),
    merchantName: organizationName(node.merchant ?? node.seller ?? node.broker),
    orderDate: toIsoDate(node.orderDate),
    totalMinorUnits: toMinorUnits(priceSpec ? priceSpec.price : node.price ?? node.totalPaymentDue),
    currency: currencyOf(priceSpec) ?? currencyOf(node),
    // e.g. "OrderDelivered" / "http://schema.org/OrderProcessing" — the bare token is what is useful.
    orderStatus: clampString(node.orderStatus)?.split("/").pop() ?? null,
    lineItems: readLineItems(node),
    url: clampString(node.url),
  };

  // A node that declared its type but stated nothing usable is not a finding. Reporting it would hand the
  // caller an empty record that looks like a real one.
  const stated =
    order.orderNumber ?? order.merchantName ?? order.orderDate ?? order.totalMinorUnits ?? (order.lineItems.length ? 1 : null);
  return stated === null || stated === undefined ? null : order;
}

function readParcel(node: Record<string, unknown>): SchemaOrgParcel | null {
  const partOfOrder = asRecord(node.partOfOrder);
  const deliveryAddress = asRecord(node.deliveryAddress);
  void deliveryAddress; // present in markup, deliberately not stored — see this module's header on retention

  const parcel: SchemaOrgParcel = {
    trackingNumber: clampString(node.trackingNumber),
    carrier: organizationName(node.carrier ?? node.provider),
    orderNumber: clampString(partOfOrder ? partOfOrder.orderNumber : null),
    merchantName: organizationName(partOfOrder ? partOfOrder.merchant ?? partOfOrder.seller : null),
    expectedArrivalFrom: toIsoDate(node.expectedArrivalFrom),
    expectedArrivalUntil: toIsoDate(node.expectedArrivalUntil),
    deliveryStatus: clampString(node.deliveryStatus)?.split("/").pop() ?? null,
    trackingUrl: clampString(node.trackingUrl),
  };

  const stated = parcel.trackingNumber ?? parcel.carrier ?? parcel.orderNumber ?? parcel.expectedArrivalFrom ?? parcel.expectedArrivalUntil;
  return stated === null ? null : parcel;
}

/**
 * schema.org's reservation types, mapped onto the four kinds this app actually models.
 *
 * Rail and coach become "rental" rather than a kind of their own: `TripSegmentExtractionSchema` calls that
 * bucket ground transport and its own example is "Amtrak Acela". A restaurant booking becomes "ticket" for
 * the same reason — it is a named thing at a named place at a stated time, which is what that kind holds.
 */
const RESERVATION_KINDS: { type: string; kind: SchemaOrgReservation["kind"] }[] = [
  { type: "FlightReservation", kind: "flight" },
  { type: "LodgingReservation", kind: "lodging" },
  { type: "RentalCarReservation", kind: "rental" },
  { type: "TrainReservation", kind: "rental" },
  { type: "BusReservation", kind: "rental" },
  { type: "EventReservation", kind: "ticket" },
  { type: "FoodEstablishmentReservation", kind: "ticket" },
];

/** Every name on the booking, as stated. Never deduplicated against household members, never inferred. */
function travelerNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  const names: string[] = [];
  for (const entry of values) {
    const record = asRecord(entry);
    const name = record ? clampString(record.name) : clampString(entry);
    if (name && !names.includes(name)) names.push(name);
    if (names.length >= 10) break;
  }
  return names;
}

function readReservation(node: Record<string, unknown>, kind: SchemaOrgReservation["kind"]): SchemaOrgReservation | null {
  const reservationFor = asRecord(node.reservationFor);
  const forNode = reservationFor ?? {};

  // Times live on the reservation for some types and on the thing reserved for others, and real senders
  // are not consistent about it. Both are read, the reservation's own value winning.
  const start = toIsoDateTime(
    node.checkinTime ?? node.pickupTime ?? node.startTime ?? forNode.departureTime ?? forNode.startDate ?? forNode.startTime,
  );
  const end = toIsoDateTime(
    node.checkoutTime ?? node.dropoffTime ?? node.endTime ?? forNode.arrivalTime ?? forNode.endDate ?? forNode.endTime,
  );

  const ticket = asRecord(node.reservedTicket);
  const seatNode = ticket ? asRecord(ticket.ticketedSeat) : null;

  const departureAirport = asRecord(forNode.departureAirport);
  const arrivalAirport = asRecord(forNode.arrivalAirport);
  const departureName =
    (departureAirport ? clampString(departureAirport.iataCode) : null) ?? placeName(forNode.departureAirport ?? forNode.departureStation ?? forNode.departureBusStop);
  const arrivalName =
    (arrivalAirport ? clampString(arrivalAirport.iataCode) : null) ?? placeName(forNode.arrivalAirport ?? forNode.arrivalStation ?? forNode.arrivalBusStop);

  const propertyName = kind === "lodging" ? placeName(node.reservationFor) : null;
  const eventName = kind === "ticket" ? clampString(forNode.name) : null;
  const venue = kind === "ticket" ? placeName(forNode.location) : null;

  const locationLabel =
    departureName && arrivalName
      ? `${departureName} → ${arrivalName}`.slice(0, MAX_STRING_LENGTH)
      : (propertyName ?? venue ?? placeName(node.pickupLocation) ?? null);

  const reservation: SchemaOrgReservation = {
    kind,
    reservationNumber: clampString(node.reservationNumber),
    providerName:
      organizationName(forNode.airline ?? forNode.provider ?? node.provider ?? node.broker ?? forNode.rentalCompany) ??
      (kind === "lodging" ? propertyName : null),
    // e.g. "http://schema.org/ReservationConfirmed" — the bare state is the useful part, and the
    // "Reservation" prefix says nothing a reader of this field does not already know.
    status: clampString(node.reservationStatus)?.split("/").pop()?.replace(/^Reservation/, "") ?? null,
    travelerNames: travelerNames(node.underName),
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    utcOffset: start.utcOffset ?? end.utcOffset,
    url: clampString(node.url ?? (ticket ? ticket.url : null)),
    locationLabel,
    flightNumber: kind === "flight" ? clampString(forNode.flightNumber) : null,
    departureAirport: kind === "flight" ? departureName : null,
    arrivalAirport: kind === "flight" ? arrivalName : null,
    seat: seatNode ? clampString(seatNode.seatNumber) : null,
    propertyName,
    vehicleOrServiceType:
      kind === "rental" ? (clampString(forNode.name) ?? clampString(forNode.model) ?? clampString(forNode.trainNumber) ?? clampString(forNode.busNumber)) : null,
    pickupLocation: kind === "rental" ? (placeName(node.pickupLocation) ?? departureName) : null,
    dropoffLocation: kind === "rental" ? (placeName(node.dropoffLocation) ?? arrivalName) : null,
    eventName,
    venue,
  };

  // A reservation node that states nothing usable is markup boilerplate, not a booking. Filing it would
  // put an empty trip segment in front of somebody.
  const stated =
    reservation.reservationNumber ??
    reservation.startDate ??
    reservation.flightNumber ??
    reservation.propertyName ??
    reservation.eventName ??
    reservation.providerName;
  return stated === null ? null : reservation;
}

/**
 * Pull every schema.org entity this app can use out of an email's HTML body.
 *
 * Never throws. A malformed block is counted in `blocksRejected` and skipped — one bad script tag in a
 * marketing footer must not cost the message its real markup, and must not fail the ingest.
 */
export function extractSchemaOrgFromHtml(html: string | null | undefined): SchemaOrgFindings {
  if (!html || typeof html !== "string") return EMPTY_FINDINGS;

  const orders: SchemaOrgOrder[] = [];
  const parcels: SchemaOrgParcel[] = [];
  const reservations: SchemaOrgReservation[] = [];
  let blocksSeen = 0;
  let blocksRejected = 0;

  SCRIPT_BLOCK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SCRIPT_BLOCK.exec(html)) !== null) {
    if (blocksSeen >= MAX_SCRIPT_BLOCKS) break;
    blocksSeen++;

    const body = match[1] ?? "";
    if (Buffer.byteLength(body, "utf8") > MAX_BLOCK_BYTES) {
      blocksRejected++;
      continue;
    }

    let parsed: unknown;
    try {
      parsed = safeParse(body);
    } catch {
      blocksRejected++;
      continue;
    }

    for (const node of walk(parsed)) {
      if (orders.length < MAX_ITEMS_PER_TYPE && isType(node, "Order")) {
        const order = readOrder(node);
        if (order) orders.push(order);
      }
      if (parcels.length < MAX_ITEMS_PER_TYPE && isType(node, "ParcelDelivery")) {
        const parcel = readParcel(node);
        if (parcel) parcels.push(parcel);
      }
      if (reservations.length < MAX_ITEMS_PER_TYPE) {
        for (const { type, kind } of RESERVATION_KINDS) {
          if (!isType(node, type)) continue;
          const reservation = readReservation(node, kind);
          if (reservation) reservations.push(reservation);
          // One node is one reservation. Without this a node typed as both would be filed twice.
          break;
        }
      }
    }
  }

  return { orders, parcels, reservations, blocksSeen, blocksRejected };
}

/** True when there is anything worth acting on — cheaper to ask than to re-derive at each call site. */
export function hasUsableMarkup(findings: SchemaOrgFindings): boolean {
  return findings.orders.length > 0 || findings.parcels.length > 0 || findings.reservations.length > 0;
}
