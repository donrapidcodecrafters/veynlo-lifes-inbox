/** Shared by every ingestion path that turns raw HTML (email bodies, fetched web pages) into plain text
 * for the extraction pipeline: strips script/style content (not just tags — their text content too, which
 * a bare tag-strip would otherwise leak straight into what the AI sees), decodes the handful of entities
 * that actually show up in real email/web markup, and collapses whitespace. */
export function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  return decodeHtmlEntities(withoutScripts.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** A captured email body or fetched page's extracted text has no business being larger than this entering
 * the extraction pipeline — shared across the Gmail/Outlook message parsers and SafeUrlFetcher. */
export const MAX_EXTRACTED_TEXT_LENGTH = 20_000;
