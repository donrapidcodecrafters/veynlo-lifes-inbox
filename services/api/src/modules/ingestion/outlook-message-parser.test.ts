import { describe, expect, it } from "vitest";
import { parseOutlookMessage, type GraphMessage } from "./outlook-message-parser";

describe("parseOutlookMessage", () => {
  it("extracts the sender address and joins multiple recipient addresses", () => {
    const message: GraphMessage = {
      subject: "Your appointment is confirmed",
      from: { emailAddress: { address: "clinic@example.com", name: "The Clinic" } },
      toRecipients: [{ emailAddress: { address: "me@example.com" } }, { emailAddress: { address: "spouse@example.com" } }],
      receivedDateTime: "2027-03-01T10:00:00Z",
      bodyPreview: "Your appointment is confirmed for...",
      body: { contentType: "text", content: "Your appointment is confirmed for March 5th at 2pm." },
    };
    const parsed = parseOutlookMessage(message);
    expect(parsed.subject).toBe("Your appointment is confirmed");
    expect(parsed.fromAddress).toBe("clinic@example.com");
    expect(parsed.toAddress).toBe("me@example.com, spouse@example.com");
    expect(parsed.dateHeader).toBe("2027-03-01T10:00:00Z");
    expect(parsed.bodyText).toBe("Your appointment is confirmed for March 5th at 2pm.");
  });

  it("never fabricates a subject or sender when they're entirely absent", () => {
    const parsed = parseOutlookMessage({});
    expect(parsed.subject).toBe("(no subject)");
    expect(parsed.fromAddress).toBe("");
    expect(parsed.toAddress).toBe("");
  });

  it("filters out a recipient with no resolvable address rather than joining an empty entry", () => {
    const message: GraphMessage = {
      toRecipients: [{ emailAddress: { address: "real@example.com" } }, { emailAddress: {} }, {}],
    };
    expect(parseOutlookMessage(message).toAddress).toBe("real@example.com");
  });

  it("strips HTML tags when the body's contentType is html", () => {
    const message: GraphMessage = {
      body: { contentType: "html", content: "<p>Hi <b>there</b></p>" },
    };
    expect(parseOutlookMessage(message).bodyText).toBe(" Hi  there  ");
  });

  it("passes plain-text body content through unchanged", () => {
    const message: GraphMessage = {
      body: { contentType: "text", content: "Plain text with <no> tags to strip" },
    };
    // contentType "text" must never run the HTML tag-strip — a literal "<no>" in a plain-text body should
    // survive verbatim, not be silently mangled as if it were markup.
    expect(parseOutlookMessage(message).bodyText).toBe("Plain text with <no> tags to strip");
  });

  it("lowercases internetMessageHeaders names, matching the Gmail parser's header shape", () => {
    const message: GraphMessage = {
      internetMessageHeaders: [
        { name: "X-Custom-Header", value: "abc123" },
        { name: "Message-ID", value: "<id@example.com>" },
      ],
    };
    const parsed = parseOutlookMessage(message);
    expect(parsed.headers["x-custom-header"]).toBe("abc123");
    expect(parsed.headers["message-id"]).toBe("<id@example.com>");
  });

  it("caps body text at 20,000 characters entering the pipeline, matching the Gmail parser", () => {
    const message: GraphMessage = { body: { contentType: "text", content: "x".repeat(25_000) } };
    expect(parseOutlookMessage(message).bodyText.length).toBe(20_000);
  });

  it("falls back to bodyPreview for the snippet field", () => {
    const message: GraphMessage = { bodyPreview: "A short preview of the message" };
    expect(parseOutlookMessage(message).snippet).toBe("A short preview of the message");
  });
});
