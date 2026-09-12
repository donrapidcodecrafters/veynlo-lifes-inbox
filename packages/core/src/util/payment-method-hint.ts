/**
 * Builds the short, non-identifying payment note shown on a purchase — "Visa •••• 4242".
 *
 * The safety property here is structural, not a filter: the model never supplies the stored string. It is
 * asked for a BRAND and the LAST FOUR DIGITS as separate, tightly-typed fields, and this composes the text
 * from them. A free-text "paymentMethodHint" field would have been simpler and is the obvious way to do
 * it — and it would mean a receipt email containing a full card number could put one straight into the
 * database, encrypted-at-rest but stored all the same, on a row that is rendered on a detail screen.
 *
 * So the worst a bad extraction can do is name the wrong brand, or the wrong four digits.
 *
 * Everything here rejects rather than truncates. Truncating a 16-digit string to its last four would
 * quietly turn a leaked PAN into a valid-looking hint and destroy the evidence that it happened;
 * returning null keeps the field empty and leaves the receipt to be looked at.
 */

/** Card networks and wallets worth naming. Anything else is stored as no brand rather than as raw text. */
const KNOWN_BRANDS = new Set([
  "visa",
  "mastercard",
  "amex",
  "american express",
  "discover",
  "diners club",
  "jcb",
  "unionpay",
  "paypal",
  "apple pay",
  "google pay",
  "venmo",
  "klarna",
  "afterpay",
  "affirm",
  "gift card",
  "store credit",
  "bank transfer",
  "cash",
]);

const DISPLAY_NAME: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "Amex",
  "american express": "Amex",
  discover: "Discover",
  "diners club": "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  paypal: "PayPal",
  "apple pay": "Apple Pay",
  "google pay": "Google Pay",
  venmo: "Venmo",
  klarna: "Klarna",
  afterpay: "Afterpay",
  affirm: "Affirm",
  "gift card": "Gift card",
  "store credit": "Store credit",
  "bank transfer": "Bank transfer",
  cash: "Cash",
};

/** The mask used between the brand and the digits. Four bullets, matching what card issuers print. */
export const PAYMENT_HINT_MASK = "••••";

/**
 * Returns the display hint, or null when there is nothing safe and useful to say.
 *
 * Null — not a partial string — whenever the input does not fit the contract: more than four digits, a
 * non-digit in the digits, or a brand nobody recognises with no digits to pair it with.
 */
export function formatPaymentMethodHint(
  brand: string | null | undefined,
  last4: string | null | undefined,
): string | null {
  const normalizedBrand = typeof brand === "string" ? brand.trim().toLowerCase() : "";
  const known = KNOWN_BRANDS.has(normalizedBrand) ? DISPLAY_NAME[normalizedBrand] : null;

  const digits = typeof last4 === "string" ? last4.trim() : "";
  // Exactly four digits or nothing. A longer run means the extraction handed back more of the card number
  // than it was asked for, and the right answer is to keep none of it.
  const validDigits = /^\d{4}$/.test(digits) ? digits : null;

  if (known && validDigits) return `${known} ${PAYMENT_HINT_MASK} ${validDigits}`;
  if (known) return known;
  // Digits with no recognised brand still say something useful ("•••• 4242") and identify nobody.
  if (validDigits) return `${PAYMENT_HINT_MASK} ${validDigits}`;
  return null;
}

/**
 * True if a string looks like it carries more card number than a hint ever should.
 *
 * A backstop for values arriving from anywhere other than `formatPaymentMethodHint` — an importer, a
 * migration, a future integration. Five or more consecutive digits is the signal: a hint contains exactly
 * four, and a real PAN fragment contains more.
 */
export function looksLikeCardNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /\d{5,}/.test(value.replace(/[\s-]/g, ""));
}
