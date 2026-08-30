import { describe, expect, it } from "vitest";
import type { gmail_v1 } from "googleapis";
import { parseGmailMessage, extractGmailAttachmentRefs } from "./gmail-message-parser";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

describe("parseGmailMessage", () => {
  it("lowercases header names and falls back to empty/default values when headers are missing", () => {
    const message: gmail_v1.Schema$Message = {
      snippet: "a short preview",
      payload: {
        headers: [
          { name: "Subject", value: "Your order has shipped" },
          { name: "From", value: "orders@example.com" },
        ],
      },
    };
    const parsed = parseGmailMessage(message);
    expect(parsed.subject).toBe("Your order has shipped");
    expect(parsed.fromAddress).toBe("orders@example.com");
    expect(parsed.toAddress).toBe("");
    expect(parsed.dateHeader).toBe("");
    expect(parsed.headers["subject"]).toBe("Your order has shipped");
    expect(parsed.snippet).toBe("a short preview");
  });

  it("never fabricates a subject when the header is entirely absent", () => {
    const parsed = parseGmailMessage({ payload: { headers: [] } });
    expect(parsed.subject).toBe("(no subject)");
  });

  it("decodes a base64url-encoded text/plain body directly", () => {
    const message: gmail_v1.Schema$Message = {
      payload: {
        headers: [{ name: "Subject", value: "Receipt" }],
        mimeType: "text/plain",
        body: { data: b64url("Total: $42.00\nThank you for your order.") },
      },
    };
    expect(parseGmailMessage(message).bodyText).toBe("Total: $42.00\nThank you for your order.");
  });

  it("prefers a nested text/plain part over a sibling text/html part in a multipart/alternative body", () => {
    const message: gmail_v1.Schema$Message = {
      payload: {
        headers: [],
        mimeType: "multipart/alternative",
        parts: [
          { mimeType: "text/html", body: { data: b64url("<p>Rich <b>version</b></p>") } },
          { mimeType: "text/plain", body: { data: b64url("Plain version") } },
        ],
      },
    };
    expect(parseGmailMessage(message).bodyText).toBe("Plain version");
  });

  it("strips HTML tags as a fallback when only a text/html part exists", () => {
    const message: gmail_v1.Schema$Message = {
      payload: {
        headers: [],
        mimeType: "text/html",
        body: { data: b64url("<div>Hello <strong>world</strong></div>") },
      },
    };
    expect(parseGmailMessage(message).bodyText).toBe("Hello world");
  });

  it("recurses into nested multipart/mixed + multipart/alternative structures to find the real body", () => {
    const message: gmail_v1.Schema$Message = {
      payload: {
        headers: [],
        mimeType: "multipart/mixed",
        parts: [
          {
            mimeType: "multipart/alternative",
            parts: [{ mimeType: "text/plain", body: { data: b64url("Nested plain body") } }],
          },
          { mimeType: "application/pdf", filename: "invoice.pdf", body: { attachmentId: "att-1" } },
        ],
      },
    };
    expect(parseGmailMessage(message).bodyText).toBe("Nested plain body");
  });

  it("caps body text at 20,000 characters entering the pipeline", () => {
    const longBody = "x".repeat(25_000);
    const message: gmail_v1.Schema$Message = {
      payload: { headers: [], mimeType: "text/plain", body: { data: b64url(longBody) } },
    };
    expect(parseGmailMessage(message).bodyText.length).toBe(20_000);
  });

  it("returns an empty body when no part contains any text", () => {
    const message: gmail_v1.Schema$Message = {
      payload: { headers: [], mimeType: "application/pdf", body: { attachmentId: "att-1" } },
    };
    expect(parseGmailMessage(message).bodyText).toBe("");
  });
});

describe("extractGmailAttachmentRefs", () => {
  it("returns nothing for an inline body part (no filename, no attachmentId)", () => {
    const part: gmail_v1.Schema$MessagePart = { mimeType: "text/plain", body: { data: b64url("hi") } };
    expect(extractGmailAttachmentRefs(part)).toEqual([]);
  });

  it("only counts a part as a real attachment when it has BOTH a filename and an attachmentId", () => {
    // A filename alone (no attachmentId) isn't a fetchable attachment — e.g. a named inline part some
    // clients emit — so this must not appear in the result.
    const part: gmail_v1.Schema$MessagePart = { mimeType: "image/png", filename: "signature.png", body: {} };
    expect(extractGmailAttachmentRefs(part)).toEqual([]);
  });

  it("extracts a real top-level attachment", () => {
    const part: gmail_v1.Schema$MessagePart = {
      mimeType: "application/pdf",
      filename: "invoice.pdf",
      body: { attachmentId: "att-123", size: 4096 },
    };
    expect(extractGmailAttachmentRefs(part)).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", attachmentId: "att-123" }]);
  });

  it("recurses through nested multipart structures to find attachments nested under the body", () => {
    const part: gmail_v1.Schema$MessagePart = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64url("body text") } }],
        },
        { mimeType: "application/pdf", filename: "receipt.pdf", body: { attachmentId: "att-1" } },
        { mimeType: "image/jpeg", filename: "photo.jpg", body: { attachmentId: "att-2" } },
      ],
    };
    const refs = extractGmailAttachmentRefs(part);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.filename)).toEqual(["receipt.pdf", "photo.jpg"]);
  });

  it("returns an empty array for an undefined part", () => {
    expect(extractGmailAttachmentRefs(undefined)).toEqual([]);
  });
});
