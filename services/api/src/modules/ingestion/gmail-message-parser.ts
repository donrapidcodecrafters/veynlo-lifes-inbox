import type { gmail_v1 } from "googleapis";

/** MAIL-004 "Attachment intelligence" — an already-fetched attachment's bytes, provided by
 * `GmailAdapter`/`OutlookAdapter` (the only two callers with actual API-client access to fetch attachment
 * bytes) and threaded through `IngestionService.ingestGmailMessage`/`ingestOutlookMessage` into
 * `classifyAndExtract`'s attachment-processing step. Provider-agnostic on purpose, since both adapters end
 * up producing the same shape despite fetching it through entirely different APIs. */
export interface EmailAttachmentInput {
  filename: string;
  mimeType: string;
  buffer: Buffer;
}

export interface ParsedEmail {
  subject: string;
  fromAddress: string;
  toAddress: string;
  dateHeader: string;
  snippet: string;
  bodyText: string;
  /**
   * The raw HTML body, when the message has one.
   *
   * `bodyText` above cannot substitute for this. A multipart/alternative message — which is what almost
   * every retailer sends — carries both parts, and `extractPlainText` deliberately prefers the plain one,
   * so the HTML is never even looked at. When it IS used, the tag-strip reduces
   * `<script type="application/ld+json">{...}</script>` to a smear of JSON in the middle of the prose.
   *
   * Either way the structured data the sender published is lost, which is why this is carried separately
   * rather than reconstructed downstream. Size-capped identically to bodyText.
   */
  bodyHtml: string | null;
  headers: Record<string, string>;
  /** Populated by IngestionService.ingestParsedEmail from the adapter-provided attachments param — never
   * set by parseGmailMessage/parseOutlookMessage themselves, which only ever see the message metadata, not
   * pre-fetched attachment bytes. Optional/defaulted to [] downstream so every existing caller/test that
   * constructs a ParsedEmail without this field keeps compiling unchanged. */
  attachments?: EmailAttachmentInput[];
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * The message's `text/html` part, untouched. Separate from `extractPlainText` on purpose: that function
 * answers "what did this message say", this one answers "what did the sender publish about it", and the
 * second question needs the markup intact.
 */
function extractHtml(part: gmail_v1.Schema$MessagePart | undefined): string | null {
  if (!part) return null;
  if (part.mimeType === "text/html" && part.body?.data) return decodeBase64Url(part.body.data);
  for (const child of part.parts ?? []) {
    const html = extractHtml(child);
    if (html) return html;
  }
  return null;
}

function extractPlainText(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) {
    return decodeBase64Url(part.body.data);
  }
  if (part.mimeType === "text/html" && part.body?.data && !part.parts) {
    // Extremely small tag-strip; the sanitized-viewer / OCR pipeline handles anything richer downstream.
    return decodeBase64Url(part.body.data).replace(/<[^>]+>/g, " ");
  }
  for (const child of part.parts ?? []) {
    const text = extractPlainText(child);
    if (text) return text;
  }
  return "";
}

/** MAIL-004 — the attachment-part METADATA a "full" format Gmail message already carries (filename,
 * mimeType, and an `attachmentId` handle) without a separate API call; the actual bytes still need a
 * dedicated `messages.attachments.get` request per part (see GmailAdapter), which is why this only returns
 * the handle, not a buffer. Recurses into `parts` since a real message's attachment can be nested a level
 * or two down (e.g. inside a multipart/mixed wrapping a multipart/alternative body). A part counts as an
 * attachment when it has both a filename and a body.attachmentId — an inline body part (the actual email
 * text) has neither. */
export interface GmailAttachmentMeta {
  attachmentId: string;
  filename: string;
  mimeType: string;
  sizeEstimate: number;
}

function collectAttachmentParts(part: gmail_v1.Schema$MessagePart | undefined, out: GmailAttachmentMeta[]): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) {
    out.push({
      attachmentId: part.body.attachmentId,
      filename: part.filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      sizeEstimate: part.body.size ?? 0,
    });
  }
  for (const child of part.parts ?? []) collectAttachmentParts(child, out);
}

export function extractGmailAttachmentMeta(message: gmail_v1.Schema$Message): GmailAttachmentMeta[] {
  const out: GmailAttachmentMeta[] = [];
  collectAttachmentParts(message.payload, out);
  return out;
}

export function parseGmailMessage(message: gmail_v1.Schema$Message): ParsedEmail {
  const headers: Record<string, string> = {};
  for (const h of message.payload?.headers ?? []) {
    if (h.name) headers[h.name.toLowerCase()] = h.value ?? "";
  }
  return {
    subject: headers["subject"] ?? "(no subject)",
    fromAddress: headers["from"] ?? "",
    toAddress: headers["to"] ?? "",
    dateHeader: headers["date"] ?? "",
    snippet: message.snippet ?? "",
    bodyText: extractPlainText(message.payload).slice(0, 20_000), // cap payload size entering the pipeline
    bodyHtml: extractHtml(message.payload)?.slice(0, 100_000) ?? null,
    headers,
  };
}
