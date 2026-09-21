/**
 * Which carrier a tracking number belongs to, and where to go to look it up.
 *
 * Spec Appendix A names eight shipping targets — UPS, FedEx, USPS, DHL, Amazon Logistics, OnTrac,
 * regional carriers and international postal. None of them has a connector, and the register classes them
 * "A/E/D varies": their APIs exist but every one needs a developer account this deployment does not have.
 *
 * What does NOT need anyone's credentials is the part a user actually reaches for. A shipment's tracking
 * number currently renders as plain text on both clients, so following it means selecting a 22-digit
 * string, copying it, finding the right carrier's website and pasting it in. Recognising the carrier from
 * the number's own shape and linking straight to their tracking page is a pure function, and it works for
 * every shipment already in the database.
 *
 * ---------------------------------------------------------------------------------------------------
 * Never guess
 * ---------------------------------------------------------------------------------------------------
 * Tracking number formats genuinely collide. A bare 12-digit number is a valid FedEx Express number AND a
 * valid USPS number; 10 digits is DHL Express and also a legacy FedEx format. There is no way to tell them
 * apart from the digits alone.
 *
 * So this returns null for anything ambiguous rather than picking the likelier one. A wrong carrier is
 * worse than no carrier: it sends someone to a site that reports "not found" for a parcel that is
 * perfectly fine, and it would overwrite a carrier name the sender stated correctly in their own email.
 * Only patterns that belong to exactly one carrier are claimed here.
 */

export type CarrierKey = "ups" | "fedex" | "usps" | "dhl" | "amazon" | "ontrac";

export interface Carrier {
  key: CarrierKey;
  label: string;
  /** Where a human goes to see this parcel. */
  trackingUrl: (trackingNumber: string) => string;
  /**
   * Patterns that identify this carrier and ONLY this carrier. Deliberately narrow — see the note above
   * on why ambiguous formats are left unclaimed.
   */
  unambiguousPatterns: RegExp[];
}

export const CARRIERS: Carrier[] = [
  {
    key: "ups",
    label: "UPS",
    trackingUrl: (n) => `https://www.ups.com/track?tracknum=${encodeURIComponent(n)}`,
    // "1Z" + 6-character shipper number + 2-digit service code + 8-digit identifier. Nothing else uses it.
    unambiguousPatterns: [/^1Z[0-9A-Z]{16}$/i],
  },
  {
    key: "usps",
    label: "USPS",
    trackingUrl: (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(n)}`,
    unambiguousPatterns: [
      // Domestic IMpb, identified by its service-type prefix. 9400/9205/9407/9303/9208/9202 are USPS's own.
      /^(9400|9205|9407|9303|9208|9202)\d{16,18}$/,
      // UPU S10 international: two letters, nine digits, two-letter country code. The trailing "US" makes
      // it USPS specifically rather than another postal operator.
      /^[A-Z]{2}\d{9}US$/i,
      /^(91|92|93|94|95)\d{18,20}$/,
    ],
  },
  {
    key: "fedex",
    label: "FedEx",
    trackingUrl: (n) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(n)}`,
    // 15 and 20 digits are FedEx formats USPS does not issue. 12 digits is deliberately NOT here: it is
    // equally a valid USPS number, and the point of this module is to refuse that rather than pick one.
    unambiguousPatterns: [/^\d{15}$/, /^\d{20}$/, /^96\d{20}$/],
  },
  {
    key: "dhl",
    label: "DHL",
    trackingUrl: (n) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(n)}`,
    // "JD" + 18 digits is DHL eCommerce. Bare 10-digit DHL Express numbers are omitted: a 10-digit string
    // is also a legacy FedEx format.
    unambiguousPatterns: [/^JD\d{18}$/i, /^JJD\d{16,18}$/i],
  },
  {
    key: "amazon",
    label: "Amazon Logistics",
    trackingUrl: (n) => `https://track.amazon.com/tracking/${encodeURIComponent(n)}`,
    unambiguousPatterns: [/^TBA\d{12,15}$/i],
  },
  {
    key: "ontrac",
    label: "OnTrac",
    trackingUrl: (n) => `https://www.ontrac.com/tracking/?number=${encodeURIComponent(n)}`,
    unambiguousPatterns: [/^(C|D)\d{14}$/i],
  },
];

/** Tracking numbers are routinely printed and pasted with spaces or dashes in them. */
function normalize(trackingNumber: string): string {
  return trackingNumber.replace(/[\s-]/g, "").trim();
}

/** Escape a literal for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
}

/**
 * The carrier this tracking number unambiguously belongs to, or null.
 *
 * Null is a real and common answer — see this module's header. A caller that wants "best guess" should
 * not use this; it exists precisely to avoid one.
 */
export function detectCarrier(trackingNumber: string | null | undefined): CarrierKey | null {
  if (!trackingNumber) return null;
  const normalized = normalize(trackingNumber);
  if (normalized.length < 8 || normalized.length > 40) return null;

  const matches = CARRIERS.filter((carrier) => carrier.unambiguousPatterns.some((pattern) => pattern.test(normalized)));
  // If two carriers' patterns both match, the patterns are not as unambiguous as they claim, and the
  // honest answer is still "unknown" rather than whichever happens to be first in the list.
  return matches.length === 1 ? matches[0]!.key : null;
}

/**
 * Match a carrier by the name an email stated, e.g. "UPS", "United Parcel Service", "U.S.P.S.".
 *
 * The USPS/UPS confusion is the most likely wrong answer this module could give, and what prevents it
 * is the WHOLE-WORD match below, not the order of the list: a containment test for "ups" would fire on
 * "Groups Inc" and on plenty of real company names. USPS is still listed first as cheap insurance for
 * whoever adds the next alias, but nothing depends on that — there is a test for the containment bug,
 * and it is the one that matters.
 */
export function carrierFromName(name: string | null | undefined): CarrierKey | null {
  if (!name) return null;
  const value = name.trim().toLowerCase();
  if (!value) return null;

  const named: Array<[CarrierKey, string[]]> = [
    ["usps", ["usps", "united states postal", "us postal service", "postal service"]],
    ["ups", ["ups", "united parcel"]],
    ["fedex", ["fedex", "fed ex", "federal express"]],
    ["dhl", ["dhl"]],
    ["amazon", ["amazon logistics", "amzl", "amazon"]],
    ["ontrac", ["ontrac", "on trac"]],
  ];

  // Punctuation-stripped form, so an initialism written "U.P.S." or "U.S.P.S." is still recognised.
  // Compared for EQUALITY, never containment: "groupsinc" must not match "ups".
  const compact = value.replace(/[^a-z0-9]/g, "");

  for (const [key, aliases] of named) {
    for (const alias of aliases) {
      if (compact === alias.replace(/[^a-z0-9]/g, "")) return key;
      // Whole-word match on the original, so "ups" does not match inside "groups" or "upstairs".
      if (new RegExp(`(^|[^a-z])${escapeRegExp(alias)}([^a-z]|$)`).test(value)) return key;
    }
  }
  return null;
}

/**
 * A link to this parcel on the carrier's own site, or null when the carrier is unknown.
 *
 * Takes the carrier name as stated — by the sender's own email, which is better evidence than a pattern —
 * and falls back to detecting it from the number's shape only when nothing was stated.
 */
export function trackingUrlFor(carrierName: string | null | undefined, trackingNumber: string | null | undefined): string | null {
  if (!trackingNumber) return null;
  const key = carrierFromName(carrierName) ?? detectCarrier(trackingNumber);
  if (!key) return null;
  const carrier = CARRIERS.find((c) => c.key === key);
  return carrier ? carrier.trackingUrl(normalize(trackingNumber)) : null;
}

export function carrierLabel(key: CarrierKey): string {
  return CARRIERS.find((c) => c.key === key)?.label ?? key;
}
