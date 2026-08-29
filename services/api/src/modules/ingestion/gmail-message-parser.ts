import type { gmail_v1 } from "googleapis";

export interface ParsedEmail {
  subject: string;
  fromAddress: string;
  toAddress: string;
  dateHeader: string;
  snippet: string;
  bodyText: string;
  headers: Record<string, string>;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
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

export interface GmailAttachmentRef {
  filename: string;
  mimeType: string;
  attachmentId: string;
}

/** MAIL-004 "attachment intelligence" — a part counts as a real attachment when it has both a filename
 * (an inline part like the plain-text/HTML body has none) and a separate `attachmentId` (Gmail's API
 * splits large/binary part bodies out from the message payload; small inline parts embed `body.data`
 * directly instead and have no attachmentId to fetch). Walks nested `multipart/*` parts recursively since
 * a real multipart/mixed message with an attachment nests it under a multipart/alternative body part. */
export function extractGmailAttachmentRefs(part: gmail_v1.Schema$MessagePart | undefined): GmailAttachmentRef[] {
  if (!part) return [];
  const refs: GmailAttachmentRef[] = [];
  if (part.filename && part.body?.attachmentId && part.mimeType) {
    refs.push({ filename: part.filename, mimeType: part.mimeType, attachmentId: part.body.attachmentId });
  }
  for (const child of part.parts ?? []) {
    refs.push(...extractGmailAttachmentRefs(child));
  }
  return refs;
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
    headers,
  };
}
