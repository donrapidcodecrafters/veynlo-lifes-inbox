import { describe, expect, it } from "vitest";
import { detectCarrier, carrierFromName, trackingUrlFor, CARRIERS } from "./carrier";

/**
 * Carrier identification.
 *
 * The important half of this file is the second describe block. Tracking number formats genuinely
 * collide — a bare 12-digit number is a valid FedEx Express number and a valid USPS number — and the
 * whole design decision here is to answer "unknown" rather than pick the likelier one. A wrong carrier
 * sends someone to a site that reports "not found" for a parcel that is perfectly fine, and would
 * overwrite a carrier the sender named correctly in their own email.
 *
 * Sample numbers are structurally real but invented; none belongs to a real shipment.
 */

describe("detectCarrier recognises what it can", () => {
  it("recognises a UPS 1Z number", () => {
    expect(detectCarrier("1Z999AA10123456784")).toBe("ups");
  });

  it("recognises USPS by its own service-type prefix", () => {
    expect(detectCarrier("9400111899223197428490")).toBe("usps");
    expect(detectCarrier("9205590123456789012345")).toBe("usps");
  });

  it("recognises a USPS international S10 number by its US country code", () => {
    expect(detectCarrier("EA123456789US")).toBe("usps");
  });

  it("recognises FedEx's 15- and 20-digit formats", () => {
    expect(detectCarrier("123456789012345")).toBe("fedex");
    expect(detectCarrier("12345678901234567890")).toBe("fedex");
  });

  it("recognises DHL eCommerce", () => {
    expect(detectCarrier("JD014600003922748698")).toBe("dhl");
  });

  it("recognises Amazon Logistics", () => {
    expect(detectCarrier("TBA123456789012")).toBe("amazon");
  });

  it("recognises OnTrac", () => {
    expect(detectCarrier("C12345678901234")).toBe("ontrac");
  });

  it("ignores the spaces and dashes people paste in", () => {
    // A tracking number copied off a printed label routinely arrives spaced.
    expect(detectCarrier("1Z 999AA1 01 2345 6784")).toBe("ups");
    expect(detectCarrier("1Z-999AA1-01-2345-6784")).toBe("ups");
  });

  it("is case-insensitive", () => {
    expect(detectCarrier("1z999aa10123456784")).toBe("ups");
  });
});

describe("detectCarrier refuses to guess", () => {
  it("returns null for a bare 12-digit number", () => {
    // THE case this module exists for: equally a valid FedEx Express and USPS number. There is no way to
    // tell them apart from the digits, so neither is claimed.
    expect(detectCarrier("123456789012")).toBeNull();
  });

  it("returns null for a bare 10-digit number", () => {
    // DHL Express, and also a legacy FedEx format.
    expect(detectCarrier("1234567890")).toBeNull();
  });

  it("returns null for an international S10 number from another country", () => {
    // "EA123456789GB" is Royal Mail, not USPS. Only the US country code identifies USPS.
    expect(detectCarrier("EA123456789GB")).toBeNull();
  });

  it("returns null for junk, empty and absent input", () => {
    expect(detectCarrier("not a tracking number")).toBeNull();
    expect(detectCarrier("")).toBeNull();
    expect(detectCarrier(null)).toBeNull();
    expect(detectCarrier(undefined)).toBeNull();
  });

  it("returns null for something far too short or far too long", () => {
    expect(detectCarrier("1Z99")).toBeNull();
    expect(detectCarrier("1".repeat(60))).toBeNull();
  });
});

describe("carrierFromName reads the name a sender stated", () => {
  it("matches the obvious names", () => {
    expect(carrierFromName("UPS")).toBe("ups");
    expect(carrierFromName("FedEx")).toBe("fedex");
    expect(carrierFromName("DHL")).toBe("dhl");
    expect(carrierFromName("OnTrac")).toBe("ontrac");
  });

  it("matches longer official names", () => {
    expect(carrierFromName("United Parcel Service")).toBe("ups");
    expect(carrierFromName("Federal Express")).toBe("fedex");
    expect(carrierFromName("United States Postal Service")).toBe("usps");
  });

  it("does not mistake USPS for UPS", () => {
    // The single most likely wrong answer in this whole module: a substring test for "ups" matches
    // inside "usps" and would route every postal parcel to the wrong carrier's website.
    expect(carrierFromName("USPS")).toBe("usps");
    expect(carrierFromName("usps")).toBe("usps");
    expect(carrierFromName("U.S.P.S.")).toBe("usps");
  });

  it("does not match a carrier name hidden inside an unrelated word", () => {
    expect(carrierFromName("Groups Inc")).toBeNull();
    expect(carrierFromName("Upstairs Furniture")).toBeNull();
  });

  it("returns null for an unknown or absent carrier", () => {
    expect(carrierFromName("Some Regional Courier")).toBeNull();
    expect(carrierFromName("")).toBeNull();
    expect(carrierFromName(null)).toBeNull();
  });
});

describe("trackingUrlFor builds a link a person can actually follow", () => {
  it("prefers the carrier the sender named over the number's shape", () => {
    // The sender's own statement is better evidence than pattern matching, and this is how a carrier
    // whose format is ambiguous still gets a working link.
    const url = trackingUrlFor("FedEx", "123456789012");
    expect(url).toContain("fedex.com");
    expect(url).toContain("123456789012");
  });

  it("falls back to detecting the carrier when none was stated", () => {
    expect(trackingUrlFor(null, "1Z999AA10123456784")).toContain("ups.com");
  });

  it("returns null when the carrier cannot be established either way", () => {
    // No link at all is the right outcome — a link to the wrong carrier is worse than none.
    expect(trackingUrlFor("Some Regional Courier", "123456789012")).toBeNull();
    expect(trackingUrlFor(null, "123456789012")).toBeNull();
  });

  it("returns null without a tracking number", () => {
    expect(trackingUrlFor("UPS", null)).toBeNull();
    expect(trackingUrlFor("UPS", "")).toBeNull();
  });

  it("strips formatting before putting the number in a URL", () => {
    const url = trackingUrlFor("UPS", "1Z 999AA1 01 2345 6784");
    expect(url).toContain("1Z999AA10123456784");
    expect(url).not.toContain(" ");
  });

  it("url-encodes the number rather than interpolating it raw", () => {
    // These values reach an href. A number carrying a query separator must not be able to extend the URL.
    const url = trackingUrlFor("UPS", "1Z999AA10123456784");
    expect(url).not.toMatch(/[<>"']/);
  });
});

describe("the carrier registry", () => {
  it("covers the Appendix A shipping targets that can be identified by format", () => {
    const keys = CARRIERS.map((c) => c.key);
    for (const key of ["ups", "fedex", "usps", "dhl", "amazon", "ontrac"]) {
      expect(keys, `${key} is missing from the carrier registry`).toContain(key);
    }
  });

  it("only ever links over https", () => {
    for (const carrier of CARRIERS) {
      expect(carrier.trackingUrl("TEST123").startsWith("https://"), `${carrier.key} is not https`).toBe(true);
    }
  });

  it("answers unknown when two carriers would both match, rather than picking by list order", () => {
    // A defensive guard that correct patterns never trigger — which is exactly why it went untested
    // until the falsifier pointed it out. Introducing the overlap on purpose is the only way to reach
    // it, and the guard is worth keeping: it is what makes a careless future pattern fail safe
    // instead of silently claiming somebody else's parcels.
    const ups = CARRIERS.find((c) => c.key === "ups")!;
    const fedex = CARRIERS.find((c) => c.key === "fedex")!;
    const original = fedex.unambiguousPatterns;
    try {
      fedex.unambiguousPatterns = [...original, ...ups.unambiguousPatterns];
      expect(detectCarrier("1Z999AA10123456784")).toBeNull();
    } finally {
      fedex.unambiguousPatterns = original;
    }
    // Restored, so the rest of the suite is unaffected.
    expect(detectCarrier("1Z999AA10123456784")).toBe("ups");
  });

  it("has no pattern that two carriers both match", () => {
    // If two claim the same shape, "unambiguous" is a lie and detectCarrier would be picking by list order.
    const samples = [
      "1Z999AA10123456784",
      "9400111899223197428490",
      "EA123456789US",
      "123456789012345",
      "12345678901234567890",
      "JD014600003922748698",
      "TBA123456789012",
      "C12345678901234",
    ];
    for (const sample of samples) {
      const matching = CARRIERS.filter((c) => c.unambiguousPatterns.some((p) => p.test(sample)));
      expect(matching.length, `"${sample}" matched ${matching.map((m) => m.key).join(" and ")}`).toBe(1);
    }
  });
});
