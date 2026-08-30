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
