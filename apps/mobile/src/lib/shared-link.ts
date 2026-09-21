/**
 * Finding the link inside whatever a share sheet handed over.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this exists
 * ---------------------------------------------------------------------------------------------------
 * Sharing a TikTok, an Instagram post, a Google Maps place or a YouTube video into Veynlo filed an item
 * called "Shared text". Every one of them. The share path posts to /v1/ingestion/manual with a literal
 * subject of "Shared text" and the shared string as the body, so a person's saved list read:
 *
 *     Shared text
 *     Shared text
 *     Shared text
 *
 * Six of Appendix A's browser/social targets and four of its maps targets arrive this way, which made
 * every one of them useless on a phone regardless of how well the server could describe the link.
 *
 * ---------------------------------------------------------------------------------------------------
 * What a share sheet actually hands over
 * ---------------------------------------------------------------------------------------------------
 * Rarely a bare URL. TikTok sends a caption and a link. Instagram sends a line of attribution. Somebody
 * forwarding a restaurant adds "for Saturday?". That surrounding text is often the only part that says
 * WHY it was saved, so it is kept and sent along with the link rather than thrown away — see the `note`
 * field on POST /v1/ingestion/url.
 */

/**
 * The first http(s) link in a shared string, and whatever else was shared with it.
 *
 * Returns null when there is no link, in which case the caller should keep treating it as plain text —
 * sharing a sentence with no URL in it is a perfectly normal thing to do and must keep working.
 */
export function splitSharedLink(shared: string): { url: string; note: string | null } | null {
  const text = (shared ?? "").trim();
  if (!text) return null;

  // Deliberately http/https only. A share can carry mailto:, tel:, geo: or an app's own scheme, and none
  // of those is a page this app can fetch and describe.
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;

  // Trailing punctuation belongs to the sentence, not the URL: "look at https://example.com/x." would
  // otherwise fetch a path ending in a full stop and 404.
  let url = match[0].replace(/[.,;:!?)\]}>"']+$/, "");
  // A closing bracket IS part of some URLs (Wikipedia especially), so one is put back when the URL has an
  // unmatched opening bracket.
  if (/\([^)]*$/.test(url) && match[0].slice(url.length).startsWith(")")) url += ")";

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    // A URL with no host is not a link to anywhere.
    if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
  } catch {
    return null;
  }

  const note = text.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return { url, note: note.length > 0 ? note : null };
}
