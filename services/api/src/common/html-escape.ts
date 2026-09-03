const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * Escapes user-controlled text (household names, rule names, etc.) before it's interpolated into a
 * hand-built HTML email body. Found live via audit: `household.name` containing `<` or `&` (e.g. "Smith &
 * Jones <Family> \"Home\"") rendered broken/missing text in the invite email's HTML part — most mail
 * clients treat an unescaped `<Family>` as an unrecognized tag and silently drop it rather than showing it
 * literally. There is no templating engine here (mailer.service.ts sends raw strings), so every call site
 * that splices user-supplied text into an `html:` body is responsible for escaping it itself — this is that
 * one shared helper, matching the same escaping every browser/React path gets for free via JSX.
 */
export function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}
