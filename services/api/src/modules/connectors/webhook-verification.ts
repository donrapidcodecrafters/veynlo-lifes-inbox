import { createHash, timingSafeEqual } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify, type JWK, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * §43/CONN-001 "Webhook endpoint verifies provider/channel signature/secret" — the pure, provider-specific
 * verification logic behind each receiver in `webhooks.controller.ts`. Kept separate from the controller
 * (which does DB lookups + queue enqueueing) so each real, documented verification scheme can be exercised
 * directly in tests against a locally generated keypair, with no live network call to Google/Plaid and no
 * live provider credentials — exactly the "receiver code is complete and correctly verifies signatures
 * against real key material" contract this module's own callers (and docs/PHASE2_PENDING_CREDENTIALS.md)
 * describe: the verification ALGORITHM is real and correct; only the "register a callback URL with the
 * provider" activation step is credential/infra-blocked (a public HTTPS endpoint, and for Gmail a real GCP
 * Pub/Sub topic).
 */

/**
 * Gmail push authentication (real, documented scheme — a Google Cloud Pub/Sub push subscription created
 * with `pushConfig.oidcToken` signs a Google-issued OIDC ID token into every push request's
 * `Authorization: Bearer <token>` header). Verifying it is exactly verifying any other Google-issued ID
 * token: RS256 signature against Google's public JWKS, `iss` must be exactly "https://accounts.google.com",
 * and `aud` must match this deployment's own webhook URL (the audience configured on the Pub/Sub
 * subscription) — the audience check is what stops a token minted for a completely different Google Cloud
 * project's push endpoint from being replayed against this one.
 *
 * `getKey` is injected (a `jose` `JWTVerifyGetKey`) rather than this function reaching for Google's real
 * JWKS endpoint itself, so it can be verified end to end — real signature check, real issuer/audience
 * check — against a locally generated RSA keypair with no network access in tests; `webhooks.controller.ts`
 * wires the real `createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"))` in production.
 * Throws (jose's own `JWTVerified`/`JOSEError` subclasses) on any verification failure — the caller decides
 * how to respond.
 */
export async function verifyGmailPushToken(token: string, audience: string, getKey: JWTVerifyGetKey): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, getKey, { issuer: "https://accounts.google.com", audience });
  return payload;
}

/** SHA-256 hex digest — used both to derive `webhook_subscriptions.channelSecretHash` at subscription-
 * creation time and to check an incoming Microsoft Graph `clientState` against it (see
 * `verifyMicrosoftClientState` below). The raw secret itself is never persisted, matching §45.1's "webhook
 * secrets... never logged" posture even though this hash — unlike a password hash — is a plain SHA-256
 * rather than a slow KDF: Graph's clientState is a high-entropy secret this app generates and controls
 * (never user-supplied/low-entropy), so a fast hash is the correct tool here, same reasoning
 * `timing-safe-equal.ts`'s callers already use for other shared-secret webhook checks. */
export function hashWebhookSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Microsoft Graph change-notification authenticity check (real, documented scheme — Graph has no per-
 * request cryptographic signature; instead, every subscription is created with an app-chosen `clientState`
 * secret, and Graph echoes it back verbatim in the `clientState` field of every notification for that
 * subscription — see https://learn.microsoft.com/graph/webhooks#notification-payload point 3, "Verify the
 * clientState property... to make sure the notification is from Microsoft Graph"). Constant-time compared
 * against the stored SHA-256 hash of the secret this app generated for that subscription, so an attacker
 * who can only observe the hash (e.g. via a DB read) still can't forge a valid `clientState`.
 */
export function verifyMicrosoftClientState(receivedClientState: string | undefined, storedSecretHash: string | null | undefined): boolean {
  if (!receivedClientState || !storedSecretHash) return false;
  const receivedHash = Buffer.from(hashWebhookSecret(receivedClientState), "utf8");
  const stored = Buffer.from(storedSecretHash, "utf8");
  if (receivedHash.length !== stored.length) return false;
  return timingSafeEqual(receivedHash, stored);
}

export interface PlaidVerificationResult {
  valid: boolean;
  reason?: "missing_header" | "malformed_token" | "missing_kid" | "unknown_key" | "invalid_signature" | "stale_token" | "body_hash_mismatch";
}

// Plaid's own documented replay-window recommendation for the `iat` claim.
const PLAID_MAX_TOKEN_AGE_SECONDS = 5 * 60;

/**
 * Plaid webhook signature verification (real, documented scheme — see
 * https://plaid.com/docs/api/webhooks/webhook-verification/): every webhook POST carries a compact JWS in
 * the `Plaid-Verification` header, ES256-signed with a key Plaid rotates and publishes per-`kid` at
 * `/webhook_verification_key/get`. The signed payload embeds `request_body_sha256` — a hash of the EXACT
 * raw request body — rather than the body itself, so `rawBody` here must be the untouched bytes Plaid sent
 * (see main.ts's `preParsing` hook for `/v1/webhooks/plaid`, which tees the raw stream before Fastify's own
 * JSON parser runs, the same mechanism already used for Stripe's billing webhook).
 *
 * @param resolveKey given a `kid` (read from the token's unverified header — safe, since the signature
 *   itself is checked afterward), returns the JWK Plaid published for it, or `null` if unknown/expired.
 *   Real wiring (`webhooks.controller.ts`) calls `PlaidAdapter.getWebhookVerificationKey`, which hits
 *   Plaid's real endpoint; tests inject a stub backed by a locally generated ES256 keypair instead.
 */
export async function verifyPlaidWebhook(
  rawBody: Buffer,
  verificationHeader: string | undefined,
  resolveKey: (keyId: string) => Promise<JWK | null>,
): Promise<PlaidVerificationResult> {
  if (!verificationHeader) return { valid: false, reason: "missing_header" };

  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(verificationHeader).kid;
  } catch {
    return { valid: false, reason: "malformed_token" };
  }
  if (!kid) return { valid: false, reason: "missing_kid" };

  const jwk = await resolveKey(kid);
  if (!jwk) return { valid: false, reason: "unknown_key" };

  let payload: { iat?: number; request_body_sha256?: string };
  try {
    const key = await importJWK(jwk, "ES256");
    const verified = await jwtVerify(verificationHeader, key, { algorithms: ["ES256"] });
    payload = verified.payload as typeof payload;
  } catch {
    return { valid: false, reason: "invalid_signature" };
  }

  if (!payload.iat || Math.abs(Date.now() / 1000 - payload.iat) > PLAID_MAX_TOKEN_AGE_SECONDS) {
    return { valid: false, reason: "stale_token" };
  }

  const actualBodyHash = createHash("sha256").update(rawBody).digest("hex");
  if (!payload.request_body_sha256 || actualBodyHash !== payload.request_body_sha256) {
    return { valid: false, reason: "body_hash_mismatch" };
  }
  return { valid: true };
}
