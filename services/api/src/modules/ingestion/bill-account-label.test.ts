import { describe, expect, it } from "vitest";
import { looksLikeFullNumber } from "@veynlo/core";

/**
 * A bill's account label is stored only when it is a LABEL, never when it is the number itself.
 *
 * Bills emails routinely print the account in full in the same message as the friendly "Account ending
 * 4321", and the extraction reads the whole message — so the value arriving here can be either. Storing
 * the full form would put an account identifier in the database on a row that is read back on a detail
 * screen and included in a data export.
 *
 * The rule is refusal, not truncation. Trimming a full account number down to its last four would
 * manufacture a plausible-looking label out of real account data and destroy the evidence that it ever
 * arrived; an empty column is visibly empty, and the email is still there to look at.
 *
 * The same helper guards the payment method hint, deliberately: both are short human-readable references
 * to something whose full form must never be kept, and a second copy of the rule is how one of them ends
 * up fixed and the other not.
 */
describe("a bill's account label never carries the account number", () => {
  it("accepts the labels billers actually print", () => {
    for (const label of ["Account ending 4321", "Acct ****8812", "Account •••• 0042", "Primary account"]) {
      expect(looksLikeFullNumber(label)).toBe(false);
    }
  });

  it("refuses anything carrying a real identifier", () => {
    for (const value of [
      "Account 100244918",
      "Acct #4242424242424242",
      "4242 4242 4242 4242",
      "4242-4242-4242-4242",
      "Account no. 88123",
    ]) {
      expect(looksLikeFullNumber(value), value).toBe(true);
    }
  });

  it("treats five digits as the boundary, because four is a reference and five is an identifier", () => {
    expect(looksLikeFullNumber("Account ending 4321")).toBe(false);
    expect(looksLikeFullNumber("Account ending 43210")).toBe(true);
  });

  it("is not fooled by separators splitting a number into short groups", () => {
    // The case a naive "no run longer than four digits" check gets wrong.
    expect(looksLikeFullNumber("1234 5678 9012 3456")).toBe(true);
  });
});
