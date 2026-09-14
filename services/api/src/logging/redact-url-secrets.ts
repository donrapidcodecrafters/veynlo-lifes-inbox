/**
 * Removes secrets that live in a URL PATH before the request is logged.
 *
 * §28.11 requires server-side redaction of "Authorization, Cookie, Set-Cookie, tokens, document text,
 * financial details". The pino `redact` config covers headers and body paths — but three public endpoints
 * carry their secret in the path itself, where no `redact` path can reach it, because `redact` matches
 * object keys and a URL is one opaque string:
 *
 *   POST /v1/share/:token/access                  — share-link redemption
 *   POST /v1/day-passes/:token/access             — caregiver day pass
 *   POST /v1/legacy-release-redeem/:token         — legacy release
 *
 * For all three the token IS the trust boundary — `public-share.controller.ts` says so outright: "the
 * token itself (plus an optional passcode) is the trust boundary, same 'no ambient session needed' posture
 * as the OAuth callback routes". So anyone able to read application logs could redeem any link that had
 * been accessed, without a session and without the emailed URL. A passcode-protected share still needs its
 * passcode; one without a passcode is fully compromised by log access alone.
 *
 * Proven before fixing, against the running API: `POST /v1/share/PROVE-TOKEN-IN-LOGS-.../access` returned
 * 404 and the log line recorded `"url":"/v1/share/PROVE-TOKEN-IN-LOGS-1788845080/access"` verbatim.
 *
 * The path SHAPE is kept — an operator still sees which endpoint was hit, and the 404/403/429 status still
 * tells them what happened. Only the secret segment goes.
 */
const TOKEN_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /^(\/v1\/share\/)[^/?]+(\/access)/,
  /^(\/v1\/day-passes\/)[^/?]+(\/access)/,
  /^(\/v1\/legacy-release-redeem\/)[^/?]+/,
];

export const REDACTED_SEGMENT = "[redacted]";

/** Replaces a secret path segment with `[redacted]`, leaving everything else — including the query — alone. */
export function redactUrlSecrets(url: string | undefined): string | undefined {
  if (!url) return url;
  for (const pattern of TOKEN_PATH_PATTERNS) {
    if (pattern.test(url)) {
      // The capture groups are sliced out of the argument list rather than destructured positionally.
      // `replace` calls the replacer as (match, ...groups, offset, string), so a pattern with ONE group
      // passes the OFFSET where a second group would sit — and a default parameter does not rescue that,
      // because 0 is not undefined. The legacy-release route has one group, and this silently produced
      // "/v1/legacy-release-redeem/[redacted]0". Caught by its own test.
      return url.replace(pattern, (...args: unknown[]) => {
        const [before, after = ""] = args.slice(1, -2) as string[];
        return `${before}${REDACTED_SEGMENT}${after}`;
      });
    }
  }
  return url;
}
