import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";

/**
 * §43.3 "Connection health model" — the 8 states the Connections page (apps/web/src/app/(app)/connections/
 * page.tsx's HEALTH_TONE map) has always had UI/styling for, but which the backend previously only ever
 * produced 4 of (`initializing`, `healthy`, `degraded`, `disconnected`) — every real provider failure
 * collapsed into a generic "degraded" via worker-main.ts's old catch-all. This module is the one place that
 * turns a thrown provider error into the right one of the remaining 4 states, so every adapter (Gmail,
 * Outlook, Google/Microsoft Calendar, Drive, OneDrive, Dropbox, Tasks/To Do, Contacts, Plaid, ICS) reports
 * the same real distinctions instead of duplicating bespoke classification logic 12 times over.
 */
export type ConnectionHealthState =
  | "initializing"
  | "healthy"
  | "degraded"
  | "rate_limited"
  | "reauth_required"
  | "permission_reduced"
  | "provider_outage"
  | "disconnected";

/** Which family of provider error shapes to interpret a thrown error against — each corresponds to a
 * distinct HTTP/OAuth error vocabulary (see extractProviderFields' own doc comment). */
export type ProviderFamily = "google" | "microsoft" | "dropbox" | "plaid" | "generic";

export interface ClassifiedConnectorError {
  health: ConnectionHealthState;
  detail: string;
}

/**
 * Every health state that still deserves another shot at the recurring incremental-sync tick (worker-
 * main.ts's connectorScanWorker, via ConnectorsService.listEligibleForIncrementalScan) — i.e. every state
 * except `reauth_required` (§43.3 "Stop unauthorized fetches" until the user reconnects), `disconnected`
 * (terminal, user-initiated — ConnectorsService.disconnect), and `initializing` (still mid-backfill; only
 * that backfill job itself flips a connection out of this state). Previously the eligibility query only
 * ever allowed `health = "healthy"`, which meant a connection marked `rate_limited`/`provider_outage`/
 * `degraded` would NEVER be retried again — silently breaking §43.3's own "rate limited... auto-recovers...
 * rather than needing manual reset" requirement, since nothing would ever attempt the "next successful
 * sync" that clears it.
 */
export const RETRIED_HEALTH_STATES: ConnectionHealthState[] = ["healthy", "degraded", "rate_limited", "provider_outage", "permission_reduced"];

function extractStatus(err: unknown): number | undefined {
  const e = err as { status?: number; code?: number | string; response?: { status?: number } } | null | undefined;
  if (!e) return undefined;
  if (typeof e.status === "number") return e.status;
  if (typeof e.code === "number") return e.code;
  if (typeof e.code === "string" && /^\d+$/.test(e.code)) return Number(e.code);
  if (typeof e.response?.status === "number") return e.response.status;
  return undefined;
}

/**
 * Normalizes the several different shapes a thrown connector error can carry into one bag the classifier
 * below can pattern-match on:
 *  - `googleapis`' own Gaxios errors (Gmail/Google Calendar/Drive/Tasks/Contacts): `response.data.error` is
 *    either a bare OAuth error code string ("invalid_grant", from a failed token refresh) or an object
 *    (`{status: "PERMISSION_DENIED"|"RESOURCE_EXHAUSTED", errors: [{reason}]}` / the older
 *    `{errors: [{reason}]}` top-level shape Calendar/Drive still use for quota errors).
 *  - This codebase's own fetch-based Microsoft Graph / Dropbox / Plaid adapters, which now attach
 *    `.status` and either `.oauthError` (the OAuth2 token endpoint's `error` field, e.g. "invalid_grant" /
 *    "AADSTS700082...") or `.plaidErrorCode` (Plaid's documented `error_code`, e.g. "ITEM_LOGIN_REQUIRED")
 *    directly on the thrown Error — see outlook.adapter.ts/onedrive.adapter.ts/dropbox.adapter.ts/
 *    microsoft-todo.adapter.ts/microsoft-contacts.adapter.ts/microsoft-calendar.adapter.ts's `requestToken`
 *    and plaid.adapter.ts's `plaidPost`.
 *  - A plain network-level failure (fetch's own "fetch failed" wrapping a `.cause` with a Node error code
 *    like ECONNREFUSED/ETIMEDOUT/ENOTFOUND) has no status at all — surfaced via `.cause?.code` in `message`.
 */
function extractProviderFields(err: unknown): { oauthError?: string; reason?: string; plaidCode?: string; message: string } {
  const e = err as
    | {
        message?: unknown;
        oauthError?: string;
        plaidErrorCode?: string;
        cause?: { code?: string };
        errors?: { reason?: string }[];
        response?: {
          data?: {
            error?: string | { status?: string; errors?: { reason?: string }[] };
            errors?: { reason?: string }[];
          };
        };
      }
    | null
    | undefined;
  const causeCode = e?.cause?.code;
  const message = `${String(e?.message ?? err ?? "")}${causeCode ? ` ${causeCode}` : ""}`;
  const data = e?.response?.data;
  const errorField = data?.error;
  const oauthError = e?.oauthError ?? (typeof errorField === "string" ? errorField : undefined);
  const reason =
    data?.errors?.[0]?.reason ??
    (errorField && typeof errorField === "object" ? (errorField.errors?.[0]?.reason ?? errorField.status) : undefined) ??
    e?.errors?.[0]?.reason;
  return { oauthError, reason, plaidCode: e?.plaidErrorCode, message };
}

const REAUTH_PATTERN =
  /invalid_grant|invalid_token|token has been expired or revoked|unauthorized_client|AADSTS700082|AADSTS70008|ITEM_LOGIN_REQUIRED|INVALID_ACCESS_TOKEN|ITEM_LOCKED/i;
const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|RATE_LIMIT_EXCEEDED|TooManyRequests/i;
// Google's API uniquely overloads HTTP 403 for both genuine permission failures AND quota/rate-limit
// errors, distinguishable only by an `errors[].reason` (or `error.status`) string — kept as its own,
// provider-gated pattern (see classifyConnectorError's `providerFamily === "google"` check below) rather
// than folded into RATE_LIMIT_PATTERN's generic scan, so a 403 from some OTHER provider whose message
// happens to contain a similar-looking word is never second-guessed into "maybe it's actually quota."
const GOOGLE_QUOTA_REASON_PATTERN = /rateLimitExceeded|userRateLimitExceeded|quotaExceeded|RESOURCE_EXHAUSTED/i;
const PERMISSION_PATTERN =
  /insufficient.?permission|insufficientPermissions|accessNotConfigured|ACCESS_NOT_GRANTED|ErrorAccessDenied|PERMISSION_DENIED/i;
const OUTAGE_PATTERN = /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNRESET|socket hang up/i;

/**
 * §43.3's actual classification: inspects the HTTP status and provider-specific error-body shape a thrown
 * connector error carries and maps it onto one of the four "real failure" health states, falling back to
 * `degraded` only when nothing more specific matched (the old, always-taken path).
 */
export function classifyConnectorError(err: unknown, providerFamily: ProviderFamily = "generic"): ClassifiedConnectorError {
  const status = extractStatus(err);
  const fields = extractProviderFields(err);
  const haystack = `${fields.oauthError ?? ""} ${fields.reason ?? ""} ${fields.plaidCode ?? ""} ${fields.message}`;

  // Reauth required — an OAuth refresh failed because the refresh token itself is invalid/expired/revoked
  // (Google's `invalid_grant`, Microsoft's AADSTS700082/70008, Plaid's ITEM_LOGIN_REQUIRED). Checked first
  // so this is never mistaken for a plain 400/401 permission or throttling error.
  if (REAUTH_PATTERN.test(haystack)) {
    return {
      health: "reauth_required",
      detail: "Veynlo's access to this account was revoked or expired. Reconnect it to resume syncing — your existing data is kept.",
    };
  }

  // Rate limited — a 429, or (Google's own quirk) a 403 whose `reason`/`status` names a quota error rather
  // than a real permission problem. Auto-recovers: the next successful sync's own unconditional
  // `health: "healthy"` write (every adapter's success path) is what actually clears this — see
  // RETRIED_HEALTH_STATES' doc comment for why this state must stay eligible for the next scan tick.
  if (status === 429 || RATE_LIMIT_PATTERN.test(haystack) || (providerFamily === "google" && GOOGLE_QUOTA_REASON_PATTERN.test(fields.reason ?? ""))) {
    return { health: "rate_limited", detail: "The provider is temporarily rate-limiting requests. Veynlo will automatically retry." };
  }

  // Permission reduced — a scope the user previously granted no longer works (a 403 that isn't rate-limit-
  // shaped above).
  if (status === 403 || PERMISSION_PATTERN.test(haystack)) {
    return {
      health: "permission_reduced",
      detail: "A previously granted permission appears to have been removed. Reconnect to restore full access.",
    };
  }

  // Provider outage — the provider's own infrastructure, not this app: a 5xx, or a network-level failure
  // that never got a response at all.
  if ((status !== undefined && status >= 500) || OUTAGE_PATTERN.test(haystack)) {
    return { health: "provider_outage", detail: "The provider appears to be experiencing an outage. Veynlo will keep retrying automatically." };
  }

  return { health: "degraded", detail: fields.message || "Sync failed for an unknown reason." };
}

/** Maps a `connections.provider` value to the error-shape family `classifyConnectorError` needs to
 * interpret it correctly (a Google 403 quota error looks nothing like a Microsoft one). */
export function providerFamilyFor(provider: string | null | undefined): ProviderFamily {
  if (!provider) return "generic";
  if (provider.startsWith("google")) return "google";
  if (provider.startsWith("microsoft") || provider === "outlook" || provider === "onedrive") return "microsoft";
  if (provider === "dropbox") return "dropbox";
  if (provider === "plaid") return "plaid";
  return "generic";
}

/**
 * Builds the thrown error for a failed OAuth2 token-endpoint request (authorization-code exchange or
 * refresh), shared by every fetch-based adapter's `requestToken` (Outlook/OneDrive/Dropbox/Microsoft To Do/
 * Microsoft Contacts/Microsoft Calendar all had their own copy of this same parse-or-swallow logic).
 * Parses the standard OAuth2 error body (`{error, error_description}` — Microsoft's and Dropbox's token
 * endpoints both use this shape) so `classifyConnectorError` can tell an `invalid_grant` (refresh token
 * revoked — reauth needed) apart from a transient token-endpoint failure that deserves a plain retry.
 */
export function oauthTokenRequestError(providerLabel: string, status: number, bodyText: string): Error & { status: number; oauthError?: string } {
  let oauthError: string | undefined;
  try {
    oauthError = (JSON.parse(bodyText) as { error?: string }).error;
  } catch {
    // Not JSON (some failure modes return a bare string/HTML) — leave oauthError undefined;
    // classifyConnectorError still has the status code and raw text to pattern-match against.
  }
  const err = new Error(`${providerLabel} token request failed: ${status} ${bodyText}`) as Error & { status: number; oauthError?: string };
  err.status = status;
  err.oauthError = oauthError;
  return err;
}

/** Same role as `oauthTokenRequestError` above, for Plaid's REST error shape (`{error_code, error_type}`
 * rather than OAuth2's `{error}`) — shared by every `PlaidAdapter.plaidPost` call site. */
export function plaidRequestError(path: string, status: number, bodyText: string): Error & { status: number; plaidErrorCode?: string } {
  let plaidErrorCode: string | undefined;
  try {
    plaidErrorCode = (JSON.parse(bodyText) as { error_code?: string }).error_code;
  } catch {
    // Not JSON — leave plaidErrorCode undefined.
  }
  const err = new Error(`Plaid request to ${path} failed: ${status} ${bodyText}`) as Error & { status: number; plaidErrorCode?: string };
  err.status = status;
  err.plaidErrorCode = plaidErrorCode;
  return err;
}

/**
 * The single write path every connector sync failure now goes through — worker-main.ts's
 * connectorSyncWorker catch-all (covers every recurring-tick-driven adapter), and the one-shot Contacts
 * adapters' own initialSync/incrementalSync (google-contacts.adapter.ts/microsoft-contacts.adapter.ts,
 * which run synchronously from handleCallback rather than through the worker and so had no health-recording
 * path on failure at all before this — a failed contacts sync left the connection stuck at `initializing`
 * forever with zero visibility).
 */
export async function recordConnectorSyncFailure(
  db: Database,
  connectionId: string,
  err: unknown,
  providerFamily: ProviderFamily = "generic",
): Promise<ClassifiedConnectorError> {
  const classified = classifyConnectorError(err, providerFamily);
  await db
    .update(schema.connections)
    .set({ health: classified.health, healthDetail: classified.detail })
    .where(eq(schema.connections.id, connectionId));
  return classified;
}
