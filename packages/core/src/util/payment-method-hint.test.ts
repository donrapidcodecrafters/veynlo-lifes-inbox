import { describe, expect, it } from "vitest";
import { formatPaymentMethodHint, looksLikeCardNumber, PAYMENT_HINT_MASK } from "./payment-method-hint";

/**
 * The point of this helper is that a full card number cannot end up in the database, so most of these
 * tests are about what it REFUSES rather than what it formats.
 */
describe("formatPaymentMethodHint", () => {
  it("composes a brand and four digits", () => {
    expect(formatPaymentMethodHint("visa", "4242")).toBe(`Visa ${PAYMENT_HINT_MASK} 4242`);
    expect(formatPaymentMethodHint("Mastercard", "1881")).toBe(`Mastercard ${PAYMENT_HINT_MASK} 1881`);
  });

  it("normalises the brands people actually write", () => {
    expect(formatPaymentMethodHint("AMERICAN EXPRESS", "0005")).toBe(`Amex ${PAYMENT_HINT_MASK} 0005`);
    expect(formatPaymentMethodHint("  apple pay  ", null)).toBe("Apple Pay");
  });

  it("keeps nothing at all when handed more of the card number than four digits", () => {
    // The case this exists for: a receipt email containing a full PAN. Truncating to the last four would
    // produce a plausible-looking hint and hide the fact that it happened.
    expect(formatPaymentMethodHint("visa", "4242424242424242")).toBe("Visa");
    expect(formatPaymentMethodHint(null, "4242424242424242")).toBeNull();
    expect(formatPaymentMethodHint("visa", "4242 4242 4242 4242")).toBe("Visa");
  });

  it("rejects digits that are not four digits", () => {
    expect(formatPaymentMethodHint(null, "424")).toBeNull();
    expect(formatPaymentMethodHint(null, "42a2")).toBeNull();
    expect(formatPaymentMethodHint(null, "")).toBeNull();
  });

  it("does not pass through an unrecognised brand as raw text", () => {
    // An unknown brand is dropped rather than stored: the field is a short note, not a place for whatever
    // free text an extraction produced.
    expect(formatPaymentMethodHint("Bank of Somewhere Cardholder Services", null)).toBeNull();
    expect(formatPaymentMethodHint("Bank of Somewhere", "4242")).toBe(`${PAYMENT_HINT_MASK} 4242`);
  });

  it("says nothing when it knows nothing", () => {
    expect(formatPaymentMethodHint(null, null)).toBeNull();
    expect(formatPaymentMethodHint(undefined, undefined)).toBeNull();
  });
});

describe("looksLikeCardNumber", () => {
  it("spots a value carrying more card number than a hint should", () => {
    expect(looksLikeCardNumber("4242424242424242")).toBe(true);
    expect(looksLikeCardNumber("4242 4242 4242 4242")).toBe(true);
    expect(looksLikeCardNumber("4242-4242-4242-4242")).toBe(true);
    expect(looksLikeCardNumber("Visa 42424")).toBe(true);
  });

  it("accepts a real hint", () => {
    expect(looksLikeCardNumber(`Visa ${PAYMENT_HINT_MASK} 4242`)).toBe(false);
    expect(looksLikeCardNumber("Apple Pay")).toBe(false);
    expect(looksLikeCardNumber(null)).toBe(false);
  });
});
