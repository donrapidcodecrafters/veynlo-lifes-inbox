import { describe, expect, it } from "vitest";
import { evaluateRelevance, matchKnownSender } from "./deterministic-prefilter";

describe("evaluateRelevance", () => {
  it("flags a receipt-shaped email as relevant even without a list header", () => {
    const result = evaluateRelevance({
      subject: "Your Amazon.com order has shipped",
      fromAddress: "shipment-tracking@amazon.com",
      snippet: "Your order #123 is on its way. Tracking number 1Z999.",
      headers: {},
    });
    expect(result.relevant).toBe(true);
    expect(result.reason).toBe("keyword_match");
  });

  it("treats a generic newsletter with a list-unsubscribe header as irrelevant", () => {
    const result = evaluateRelevance({
      subject: "This week's top stories",
      fromAddress: "newsletter@example.com",
      snippet: "Here's what's new this week in tech.",
      headers: { "list-unsubscribe": "<mailto:unsub@example.com>" },
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe("mailing_list_header");
  });

  it("treats plain conversational email as irrelevant", () => {
    const result = evaluateRelevance({
      subject: "Dinner Friday?",
      fromAddress: "friend@example.com",
      snippet: "Want to grab dinner this Friday?",
      headers: {},
    });
    expect(result.relevant).toBe(false);
    expect(result.reason).toBe("no_relevance_signal");
  });
});

describe("matchKnownSender", () => {
  it("matches a pure-shipment carrier domain regardless of subject text", () => {
    expect(matchKnownSender("mcinfo@ups.com")).toEqual({ merchantName: "UPS", category: "shipment" });
    expect(matchKnownSender("mcinfo@ups.com", "Your invoice is ready")).toEqual({ merchantName: "UPS", category: "shipment" });
  });

  it("defaults an ambiguous sender (Amazon) to receipt when the subject has no shipment signal", () => {
    expect(matchKnownSender("auto-confirm@amazon.com", "Your Amazon.com order confirmation")).toEqual({
      merchantName: "Amazon",
      category: "receipt",
    });
    expect(matchKnownSender("auto-confirm@amazon.com")).toEqual({ merchantName: "Amazon", category: "receipt" });
  });

  it("classifies an ambiguous sender (Amazon) as shipment when the subject has a shipping signal — the real bug this fixes", () => {
    // Before this fix, every amazon.com email was hardcoded to "receipt", so a real shipping-confirmation
    // email from Amazon was routed through the receipt extractor instead of the shipment one.
    expect(matchKnownSender("ship-confirm@amazon.com", "Your package has shipped")).toEqual({
      merchantName: "Amazon",
      category: "shipment",
    });
    expect(matchKnownSender("ship-confirm@amazon.com", "Your order is out for delivery")).toEqual({
      merchantName: "Amazon",
      category: "shipment",
    });
  });

  it("returns null for an unrecognized domain rather than guessing", () => {
    expect(matchKnownSender("hello@some-random-store.example")).toBeNull();
  });

  it("returns null for a malformed address instead of throwing", () => {
    expect(matchKnownSender("not-an-email")).toBeNull();
  });

  it("matches a real 'Display Name <address>' From header, not just a bare address — the real bug this fixes", () => {
    // Before this fix, `fromAddress.split("@")[1]` on the raw header produced domain "amazon.com>" (with a
    // trailing angle bracket) for any header carrying a display name — the common real-world shape for
    // bulk senders — so this entire fast path silently never matched real Gmail/Outlook messages.
    expect(matchKnownSender('"Amazon.com" <auto-confirm@amazon.com>', "Your order has shipped")).toEqual({
      merchantName: "Amazon",
      category: "shipment",
    });
    expect(matchKnownSender("UPS <mcinfo@ups.com>")).toEqual({ merchantName: "UPS", category: "shipment" });
  });
});
