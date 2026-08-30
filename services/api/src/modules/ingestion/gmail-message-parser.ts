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

/** Depth-first search for the first leaf part matching `mimeType` anywhere in the tree — order-independent,
 * unlike a single combined traversal that just returns whichever type it happens to encounter first. */
function findPart(part: gmail_v1.Schema$MessagePart | undefined, mimeType: string): gmail_v1.Schema$MessagePart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data && !part.parts) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Caught by a real test, not inferred: a single combined depth-first traversal returning whichever of
 * text/plain or text/html it encountered FIRST only "prefers" plain text when the message happens to list
 * that part before its HTML sibling — true for a real Gmail multipart/alternative body per RFC 2046
 * convention, but not something the code itself ever enforced. Two separate whole-tree searches (plain
 * first, html only as a genuine fallback) make that preference real regardless of part ordering. */
function extractPlainText(part: gmail_v1.Schema$MessagePart | undefined): string {
  const plainPart = findPart(part, "text/plain");
  if (plainPart?.body?.data) return decodeBase64Url(plainPart.body.data);
  const htmlPart = findPart(part, "text/html");
  if (htmlPart?.body?.data) {
    // Extremely small tag-strip; the sanitized-viewer / OCR pipeline handles anything richer downstream.
    return decodeBase64Url(htmlPart.body.data).replace(/<[^>]+>/g, " ");
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
