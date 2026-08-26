import type { ParsedEmail } from "./gmail-message-parser";

/** The subset of a Microsoft Graph message resource this parser actually reads. */
export interface GraphMessage {
  id?: string;
  subject?: string | null;
  from?: { emailAddress?: { address?: string | null; name?: string | null } | null } | null;
  toRecipients?: Array<{ emailAddress?: { address?: string | null } | null }> | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  body?: { contentType?: "text" | "html" | null; content?: string | null } | null;
  internetMessageHeaders?: Array<{ name?: string | null; value?: string | null }> | null;
}

export function parseOutlookMessage(message: GraphMessage): ParsedEmail {
  const bodyContent = message.body?.content ?? "";
  const bodyText =
    message.body?.contentType === "html"
      ? bodyContent.replace(/<[^>]+>/g, " ") // same extremely small tag-strip as the Gmail HTML fallback path
      : bodyContent;

  const headers: Record<string, string> = {};
  for (const h of message.internetMessageHeaders ?? []) {
    if (h.name) headers[h.name.toLowerCase()] = h.value ?? "";
  }

  return {
    subject: message.subject ?? "(no subject)",
    fromAddress: message.from?.emailAddress?.address ?? "",
    toAddress: (message.toRecipients ?? []).map((r) => r.emailAddress?.address).filter(Boolean).join(", "),
    dateHeader: message.receivedDateTime ?? "",
    snippet: message.bodyPreview ?? "",
    bodyText: bodyText.slice(0, 20_000), // cap payload size entering the pipeline, matching the Gmail parser
    headers,
  };
}
