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
  it("matches a known high-volume sender domain", () => {
    expect(matchKnownSender("auto-confirm@amazon.com")).toEqual({ merchantName: "Amazon", category: "receipt" });
    expect(matchKnownSender("mcinfo@ups.com")).toEqual({ merchantName: "UPS", category: "shipment" });
  });

  it("returns null for an unrecognized domain rather than guessing", () => {
    expect(matchKnownSender("hello@some-random-store.example")).toBeNull();
  });

  it("returns null for a malformed address instead of throwing", () => {
    expect(matchKnownSender("not-an-email")).toBeNull();
  });
});
