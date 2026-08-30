import { describe, expect, it } from "vitest";
import { applyPrivacyLevel } from "./notification-privacy";

describe("applyPrivacyLevel", () => {
  it("full — passes title and body through unchanged", () => {
    const result = applyPrivacyLevel("Comcast bill due", "Your bill of 45.00 USD is due in 3 days.", "bill", "full");
    expect(result).toEqual({ title: "Comcast bill due", body: "Your bill of 45.00 USD is due in 3 days." });
  });

  it("hide_amounts — redacts a money()-style amount but leaves the title alone", () => {
    const result = applyPrivacyLevel("Comcast bill due", "Your bill of 45.00 USD is due in 3 days.", "bill", "hide_amounts");
    expect(result).toEqual({ title: "Comcast bill due", body: "Your bill of [amount hidden] is due in 3 days." });
  });

  it("hide_amounts — redacts a plain $-prefixed amount, including thousands separators", () => {
    const result = applyPrivacyLevel("Payment failed", "We couldn't charge $1,234.56 to your card.", "billing", "hide_amounts");
    expect(result.body).toBe("We couldn't charge [amount hidden] to your card.");
  });

  it("hide_amounts — redacts a bare $ amount with no thousands separator", () => {
    const result = applyPrivacyLevel("Refund issued", "You were refunded $45.00.", "purchase", "hide_amounts");
    expect(result.body).toBe("You were refunded [amount hidden].");
  });

  it("hide_titles — redacts amounts AND replaces the title with a category-derived label", () => {
    const result = applyPrivacyLevel("Comcast bill due", "Your bill of 45.00 USD is due in 3 days.", "bill", "hide_titles");
    expect(result).toEqual({ title: "Bill reminder", body: "Your bill of [amount hidden] is due in 3 days." });
  });

  it("hide_titles — falls back to a generic label for a null category", () => {
    const result = applyPrivacyLevel("Some real title", "body", null, "hide_titles");
    expect(result.title).toBe("Veynlo update");
  });

  it("hide_titles — falls back to a generic label for an unrecognized category", () => {
    const result = applyPrivacyLevel("Some real title", "body", "something_new", "hide_titles");
    expect(result.title).toBe("Veynlo update");
  });

  it("hide_titles — maps daily_brief and weekly_brief to the same brief label", () => {
    expect(applyPrivacyLevel("t", "b", "daily_brief", "hide_titles").title).toBe("Your brief is ready");
    expect(applyPrivacyLevel("t", "b", "weekly_brief", "hide_titles").title).toBe("Your brief is ready");
  });

  it("generic — replaces both title and body with fixed, non-identifying strings", () => {
    const result = applyPrivacyLevel("Comcast bill due", "Your bill of 45.00 USD is due in 3 days.", "bill", "generic");
    expect(result).toEqual({ title: "Veynlo", body: "You have a new notification. Open the app for details." });
  });
});
