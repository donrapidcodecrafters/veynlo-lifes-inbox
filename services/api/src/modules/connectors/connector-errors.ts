export class ConnectorNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} connector is not configured on this deployment (missing OAuth client credentials).`);
    this.name = "ConnectorNotConfiguredError";
  }
}

/**
 * §54.2 launch criteria #6 "connector flows survive... provider rate limit, outage, token expiry/reauth"
 * — the worker's connector-sync job catch previously set every failure to `health: "degraded"` regardless
 * of cause, and the web/mobile Connections UI already had distinct badges/copy for `rate_limited`,
 * `provider_outage`, and `reauth_required` (visible in `HEALTH_TONE` on both platforms) that nothing in
 * the backend had ever actually set. A user seeing "degraded" for a rate limit that will clear on its own
 * in a minute can't tell that apart from a real broken connection needing their attention.
 *
 * Covers both HTTP-status shapes every adapter in this module actually throws: googleapis' own error
 * shape (`err.code` / `err.response.status` — Gmail, Google Calendar, Google Tasks) and the plain
 * `Error` with a manually-attached `.status` every Microsoft Graph fetch call in this codebase uses
 * (Outlook, Microsoft Calendar, Microsoft Todo). Falls back to "degraded" for anything it can't
 * classify (a genuine bug, a network error, ICS fetch failures) — same behavior as before this existed.
 */
export type ConnectorHealthState = "rate_limited" | "reauth_required" | "provider_outage" | "degraded";

export function classifyConnectorError(err: unknown): ConnectorHealthState {
  const status =
    (err as { status?: number })?.status ?? (err as { code?: number })?.code ?? (err as { response?: { status?: number } })?.response?.status;
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "reauth_required";
  if (typeof status === "number" && status >= 500 && status < 600) return "provider_outage";
  return "degraded";
}

/**
 * §43.3 "permission_reduced" — a real, distinct connection-health state that existed only as UI-rendered
 * dead code (the web/mobile Connections badge already had a tone for it) with nothing on the backend ever
 * setting it. A user who narrows what they grant mid-consent-flow, or whose org admin later restricts an
 * OAuth app's approved scopes, still gets a "healthy"/successfully-syncing connection that's silently
 * missing capability it claims to have — indistinguishable from one with full access until something that
 * needed the missing scope fails outright.
 *
 * `connections.scopes` is repurposed here to store what the OAuth token response actually granted
 * (`tokens.scope`, space-separated) rather than what was requested — the requested set is a compile-time
 * constant per adapter with nothing to gain from persisting it, and nothing in the codebase ever read the
 * old "requested" value back. A connection from before this existed has an empty `scopes` array (the
 * column's default) — treated as "unknown, assume healthy" rather than a false permission_reduced, since
 * there's no real signal to act on for it.
 */
export function classifyPermissionHealth(grantedScopes: string[], requiredScopes: string[]): "healthy" | "permission_reduced" {
  if (grantedScopes.length === 0) return "healthy";
  const granted = new Set(grantedScopes);
  return requiredScopes.every((scope) => granted.has(scope)) ? "healthy" : "permission_reduced";
}

/** OAuth token responses carry granted scope as one space-separated string (or omit it entirely on a
 * token refresh, where providers commonly assume "unchanged from the original grant"). */
export function parseGrantedScopes(scopeString: string | null | undefined): string[] {
  return scopeString ? scopeString.split(/\s+/).filter(Boolean) : [];
}

/** Upper bound on how long a single Retry-After can push the connector-scan worker's re-inclusion cooldown
 * out — a provider returning a bogus or absurdly large value shouldn't be able to park a connection
 * indefinitely; the user's own reconnect flow is always the real escape hatch regardless. */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000;

/** A 429's `Retry-After` header, per RFC 9110 §10.2.3, is either a delay in whole seconds or an HTTP-date
 * — every real rate-limit response this codebase's providers send uses the numeric-seconds form, which is
 * what this reads; an HTTP-date value (rare in practice for this header) is left unhandled rather than
 * guessed at. Accepts either a Headers-like object (`.get()`) or a plain header map, since googleapis'
 * underlying HTTP client and the Microsoft adapters' raw `fetch` responses don't expose the header the
 * same way. Returns null when there's nothing real to act on — the caller falls back to the existing flat
 * cooldown, never to a fabricated wait. */
export function extractRetryAfterMs(err: unknown): number | null {
  const headers = (err as { retryAfterHeader?: string })?.retryAfterHeader ?? readHeader(err, "retry-after");
  if (!headers) return null;
  const seconds = Number(headers);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function readHeader(err: unknown, name: string): string | null {
  const headers = (err as { response?: { headers?: unknown } })?.response?.headers;
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const plain = headers as Record<string, string | string[] | undefined>;
  const key = Object.keys(plain).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? plain[key] : undefined;
  return Array.isArray(value) ? (value[0] ?? null) : (value ?? null);
}
