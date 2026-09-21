import { describe, expect, it } from "vitest";
import { extractSchemaOrgFromHtml, hasUsableMarkup } from "./schema-org-email";

/**
 * The reservations airlines, hotels and ticketing sites already publish in their own confirmation emails.
 *
 * Appendix A lists 23 travel targets and every one of them sat in the "served by the email pipeline"
 * column, which in practice meant "a model reads the prose". Reservation markup is what the industry
 * standardised on instead: it states the confirmation number rather than inferring it, costs no model
 * call, and works for a household that has turned AI processing off.
 *
 * The failure to guard against here is a wrong DATE or a wrong TIME. A flight filed an hour late is worse
 * than a flight not filed at all, because somebody plans around it.
 */

const wrap = (json: unknown) => `<html><body><script type="application/ld+json">${JSON.stringify(json)}</script></body></html>`;

describe("a flight confirmation", () => {
  const flight = {
    "@context": "http://schema.org",
    "@type": "FlightReservation",
    reservationNumber: "RXJ34P",
    reservationStatus: "http://schema.org/ReservationConfirmed",
    underName: { "@type": "Person", name: "Alex Rivera" },
    url: "https://airline.test/manage/RXJ34P",
    reservedTicket: { "@type": "Ticket", ticketedSeat: { "@type": "Seat", seatNumber: "14C" } },
    reservationFor: {
      "@type": "Flight",
      flightNumber: "UA 123",
      airline: { "@type": "Airline", name: "United Airlines" },
      departureAirport: { "@type": "Airport", iataCode: "SFO", name: "San Francisco International" },
      arrivalAirport: { "@type": "Airport", iataCode: "JFK", name: "John F. Kennedy International" },
      departureTime: "2026-04-15T18:30:00-07:00",
      arrivalTime: "2026-04-16T03:05:00-04:00",
    },
  };

  it("reads everything the airline stated", () => {
    const found = extractSchemaOrgFromHtml(wrap(flight));
    expect(found.reservations).toHaveLength(1);
    const r = found.reservations[0]!;
    expect(r.kind).toBe("flight");
    expect(r.reservationNumber).toBe("RXJ34P");
    expect(r.providerName).toBe("United Airlines");
    expect(r.flightNumber).toBe("UA 123");
    expect(r.seat).toBe("14C");
    expect(r.travelerNames).toEqual(["Alex Rivera"]);
    expect(r.url).toBe("https://airline.test/manage/RXJ34P");
  });

  it("prefers the IATA code to the airport's full name", () => {
    // "SFO → JFK" is what a person reads at a glance; "San Francisco International → John F. Kennedy
    // International" is the same fact taking four times the space on a phone.
    const r = extractSchemaOrgFromHtml(wrap(flight)).reservations[0]!;
    expect(r.departureAirport).toBe("SFO");
    expect(r.arrivalAirport).toBe("JFK");
    expect(r.locationLabel).toBe("SFO → JFK");
  });

  it("keeps the departure TIME, not just the date", () => {
    // `toIsoDate` throws the time away, which is right for an order date and wrong here: a flight filed
    // without its time is a flight somebody can miss.
    const r = extractSchemaOrgFromHtml(wrap(flight)).reservations[0]!;
    expect(r.startDate).toBe("2026-04-15");
    expect(r.startTime).toBe("18:30");
    expect(r.endDate).toBe("2026-04-16");
    expect(r.endTime).toBe("03:05");
  });

  it("keeps the offset the airline stated, and never guesses one", () => {
    const r = extractSchemaOrgFromHtml(wrap(flight)).reservations[0]!;
    expect(r.utcOffset).toBe("-07:00");

    // With no zone stated there is nothing to record. Deriving one from "SFO" would be inventing a fact,
    // and the caller resolves an unzoned time the same way it resolves every other one.
    const noZone = {
      ...flight,
      reservationFor: { ...flight.reservationFor, departureTime: "2026-04-15T18:30:00", arrivalTime: "2026-04-16T03:05:00" },
    };
    expect(extractSchemaOrgFromHtml(wrap(noZone)).reservations[0]!.utcOffset).toBeNull();
    expect(extractSchemaOrgFromHtml(wrap(noZone)).reservations[0]!.startTime).toBe("18:30");
  });

  it("reads a Z suffix as UTC", () => {
    const utc = { ...flight, reservationFor: { ...flight.reservationFor, departureTime: "2026-04-15T18:30:00Z" } };
    expect(extractSchemaOrgFromHtml(wrap(utc)).reservations[0]!.utcOffset).toBe("+00:00");
  });

  it("reads an offset written without its colon", () => {
    const compact = { ...flight, reservationFor: { ...flight.reservationFor, departureTime: "2026-04-15T18:30:00-0700" } };
    expect(extractSchemaOrgFromHtml(wrap(compact)).reservations[0]!.utcOffset).toBe("-07:00");
  });

  it("drops an impossible time rather than repairing it", () => {
    const bad = { ...flight, reservationFor: { ...flight.reservationFor, departureTime: "2026-04-15T25:99:00-07:00" } };
    const r = extractSchemaOrgFromHtml(wrap(bad)).reservations[0]!;
    // The date is still real and is kept; only the unusable part is dropped.
    expect(r.startDate).toBe("2026-04-15");
    expect(r.startTime).toBeNull();
  });

  it("says when the airline cancelled it", () => {
    const cancelled = { ...flight, reservationStatus: "http://schema.org/ReservationCancelled" };
    expect(extractSchemaOrgFromHtml(wrap(cancelled)).reservations[0]!.status).toBe("Cancelled");
    expect(extractSchemaOrgFromHtml(wrap(flight)).reservations[0]!.status).toBe("Confirmed");
  });

  it("reads every leg of a multi-leg booking", () => {
    // A return trip is two FlightReservation nodes in one email. Reading only the first loses the way home.
    const outbound = flight;
    const inbound = {
      ...flight,
      reservationNumber: "RXJ34P",
      reservedTicket: { "@type": "Ticket", ticketedSeat: { "@type": "Seat", seatNumber: "22A" } },
      reservationFor: {
        ...flight.reservationFor,
        flightNumber: "UA 456",
        departureAirport: { "@type": "Airport", iataCode: "JFK" },
        arrivalAirport: { "@type": "Airport", iataCode: "SFO" },
        departureTime: "2026-04-22T09:00:00-04:00",
      },
    };
    const found = extractSchemaOrgFromHtml(wrap([outbound, inbound]));
    expect(found.reservations).toHaveLength(2);
    expect(found.reservations.map((r) => r.flightNumber)).toEqual(["UA 123", "UA 456"]);
  });
});

describe("a hotel confirmation", () => {
  const lodging = {
    "@context": "http://schema.org",
    "@type": "LodgingReservation",
    reservationNumber: "H-88213",
    reservationStatus: "http://schema.org/ReservationConfirmed",
    underName: { "@type": "Person", name: "Alex Rivera" },
    checkinTime: "2026-04-15T15:00:00-04:00",
    checkoutTime: "2026-04-18T11:00:00-04:00",
    reservationFor: {
      "@type": "LodgingBusiness",
      name: "The Harbour Hotel",
      address: { "@type": "PostalAddress", streetAddress: "12 Dock St", addressLocality: "Boston", addressRegion: "MA" },
    },
  };

  it("reads the property, the dates and the times", () => {
    const r = extractSchemaOrgFromHtml(wrap(lodging)).reservations[0]!;
    expect(r.kind).toBe("lodging");
    expect(r.propertyName).toBe("The Harbour Hotel");
    expect(r.reservationNumber).toBe("H-88213");
    expect(r.startDate).toBe("2026-04-15");
    expect(r.startTime).toBe("15:00");
    expect(r.endDate).toBe("2026-04-18");
    expect(r.endTime).toBe("11:00");
  });

  it("uses the property as the provider when no separate one is named", () => {
    // A hotel booked directly names no broker. Leaving the provider null would show a trip segment with no
    // company on it at all.
    expect(extractSchemaOrgFromHtml(wrap(lodging)).reservations[0]!.providerName).toBe("The Harbour Hotel");
  });

  it("falls back to the address when the property has no name", () => {
    const unnamed = { ...lodging, reservationFor: { ...lodging.reservationFor, name: undefined } };
    expect(extractSchemaOrgFromHtml(wrap(unnamed)).reservations[0]!.propertyName).toBe("12 Dock St, Boston, MA");
  });
});

describe("ground transport", () => {
  it("reads a hire car, including where it is picked up and dropped off", () => {
    const rental = {
      "@type": "RentalCarReservation",
      reservationNumber: "CAR-5521",
      pickupTime: "2026-04-16T10:00:00-04:00",
      dropoffTime: "2026-04-18T10:00:00-04:00",
      pickupLocation: { "@type": "Place", name: "Boston Logan Airport" },
      dropoffLocation: { "@type": "Place", name: "Boston South Station" },
      reservationFor: { "@type": "RentalCar", name: "Compact car", rentalCompany: { "@type": "Organization", name: "Hertz" } },
    };
    const r = extractSchemaOrgFromHtml(wrap(rental)).reservations[0]!;
    expect(r.kind).toBe("rental");
    expect(r.providerName).toBe("Hertz");
    expect(r.vehicleOrServiceType).toBe("Compact car");
    expect(r.pickupLocation).toBe("Boston Logan Airport");
    expect(r.dropoffLocation).toBe("Boston South Station");
    expect(r.startTime).toBe("10:00");
  });

  it("files rail as ground transport rather than losing it", () => {
    // TripSegmentExtractionSchema has no rail kind and its own example for this bucket is "Amtrak Acela".
    const train = {
      "@type": "TrainReservation",
      reservationNumber: "TR-77",
      reservationFor: {
        "@type": "TrainTrip",
        trainNumber: "Acela 2150",
        provider: { "@type": "Organization", name: "Amtrak" },
        departureStation: { "@type": "TrainStation", name: "Boston South Station" },
        arrivalStation: { "@type": "TrainStation", name: "New York Penn Station" },
        departureTime: "2026-04-19T07:15:00-04:00",
      },
    };
    const r = extractSchemaOrgFromHtml(wrap(train)).reservations[0]!;
    expect(r.kind).toBe("rental");
    expect(r.providerName).toBe("Amtrak");
    expect(r.vehicleOrServiceType).toBe("Acela 2150");
    expect(r.locationLabel).toBe("Boston South Station → New York Penn Station");
  });
});

describe("tickets and tables", () => {
  it("reads an event ticket", () => {
    const event = {
      "@type": "EventReservation",
      reservationNumber: "EVT-9001",
      reservationFor: {
        "@type": "Event",
        name: "Hamilton",
        startDate: "2026-05-02T19:30:00-04:00",
        location: { "@type": "Place", name: "Richard Rodgers Theatre" },
      },
    };
    const r = extractSchemaOrgFromHtml(wrap(event)).reservations[0]!;
    expect(r.kind).toBe("ticket");
    expect(r.eventName).toBe("Hamilton");
    expect(r.venue).toBe("Richard Rodgers Theatre");
    expect(r.startDate).toBe("2026-05-02");
    expect(r.startTime).toBe("19:30");
  });

  it("reads a restaurant booking", () => {
    const table = {
      "@type": "FoodEstablishmentReservation",
      reservationNumber: "TBL-42",
      startTime: "2026-05-02T18:00:00-04:00",
      partySize: 4,
      reservationFor: { "@type": "FoodEstablishment", name: "Tartine Bakery" },
    };
    const r = extractSchemaOrgFromHtml(wrap(table)).reservations[0]!;
    expect(r.kind).toBe("ticket");
    expect(r.eventName).toBe("Tartine Bakery");
    expect(r.startTime).toBe("18:00");
  });
});

describe("what is refused", () => {
  it("ignores a reservation node that states nothing usable", () => {
    // An empty shell is markup boilerplate, not a booking. Filing it puts a blank trip segment in front of
    // somebody, which is worse than filing nothing.
    const found = extractSchemaOrgFromHtml(wrap({ "@type": "FlightReservation", "@context": "https://schema.org" }));
    expect(found.reservations).toHaveLength(0);
    expect(hasUsableMarkup(found)).toBe(false);
  });

  it("does not file one node twice when it declares two reservation types", () => {
    const both = { "@type": ["FlightReservation", "EventReservation"], reservationNumber: "DUP-1" };
    expect(extractSchemaOrgFromHtml(wrap(both)).reservations).toHaveLength(1);
  });

  it("ignores a reservation type this app does not model", () => {
    // TaxiReservation is real schema.org and is not something this app has a kind for. Guessing one would
    // file a taxi as a hire car.
    const taxi = { "@type": "TaxiReservation", reservationNumber: "TX-1", pickupTime: "2026-04-16T10:00:00Z" };
    expect(extractSchemaOrgFromHtml(wrap(taxi)).reservations).toHaveLength(0);
  });

  it("reads a reservation alongside an order in the same message", () => {
    // A package holiday confirmation carries both, and reading only one of them loses half the email.
    const html = `<html><body>
      <script type="application/ld+json">${JSON.stringify({ "@type": "Order", orderNumber: "PKG-1", seller: "Travel Co" })}</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "LodgingReservation", reservationNumber: "H-2", reservationFor: { "@type": "LodgingBusiness", name: "Seaside Inn" } })}</script>
    </body></html>`;
    const found = extractSchemaOrgFromHtml(html);
    expect(found.orders).toHaveLength(1);
    expect(found.reservations).toHaveLength(1);
    expect(hasUsableMarkup(found)).toBe(true);
  });

  it("bounds how many reservations one email can contribute", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ "@type": "FlightReservation", reservationNumber: `F-${i}` }));
    expect(extractSchemaOrgFromHtml(wrap(many)).reservations.length).toBeLessThanOrEqual(50);
  });
});
