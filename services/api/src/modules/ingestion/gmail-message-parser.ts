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
