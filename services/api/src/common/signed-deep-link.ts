import { createHmac } from "node:crypto";
import { loadEnv } from "../config/env";
import { timingSafeEqualString } from "./timing-safe-equal";

/**
 * §36 SYS-001..008 "deep links use signed/internal routes" — every one of the eight widget/App-Intent/
 * wearable/live-activity spec items shares this identical line. A native widget/watch/Live-Activity
 * surface needs to jump a tap straight into a specific object (a purchase, a trip, an inbox item) without
 * a full interactive auth round trip, while still being tamper-proof and expiring — the same "signed,
 * time-limited, stateless" shape as a JWT, but purpose-built for this one narrow use (encode WHERE to
 * route, never WHAT the object contains), so it's its own tiny format rather than overloading the session
 * JWT (`SESSION_JWT_SECRET`/`AuthGuard`) or the DB-backed high-entropy share-link tokens
 * (`SharingService.createShareLink`) — neither of which fits: a session JWT authenticates a whole session,
 * and a share link is a persistent, revocable, DB-stored grant, both meaningfully heavier machinery than
 * "let this specific widget tap open this specific screen for the next few minutes."
 *
 * Deliberately stateless (no DB row, no revocation list) — resolving a token only ever returns a route to
 * open, never resource content; the app's own normal authorization runs again once that screen actually
 * loads the object, exactly like clicking a plain deep link typed into the address bar would. A stolen
 * token can therefore only redirect a phone that's already signed into SOME Veynlo account to a route
 * (which then 403s if that account doesn't own the resource) — never exfiltrate data on its own, matching
 * the spec's "no secrets in widget timeline/push data" line one level up.
 *
 * Format: `<base64url(JSON payload)>.<base64url(HMAC-SHA256 signature)>` — structurally similar to a JWT
 * but intentionally not a real JWT/JWS (no alg-negotiation surface to misuse; see `AuthGuard`'s own doc
 * comment on why an explicit algorithm allowlist matters for that concern elsewhere).
 */
export interface DeepLinkResource {
  resourceType: string;
  resourceId: string;
}

interface DeepLinkPayload extends DeepLinkResource {
  exp: number; // unix seconds
}

function sign(payloadB64: string): string {
  const secret = loadEnv().DEEPLINK_SIGNING_SECRET;
  return createHmac("sha256", secret).update(payloadB64).digest("base64url");
}

/** Mints a signed, expiring deep-link token for one resource. `ttlSeconds` should stay short (minutes,
 * not days) — a widget mints one of these fresh each time it refreshes its snapshot, not once and reuses
 * it indefinitely. */
export function createSignedDeepLink(resource: DeepLinkResource, ttlSeconds: number): string {
  const payload: DeepLinkPayload = {
    resourceType: resource.resourceType,
    resourceId: resource.resourceId,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${payloadB64}.${sign(payloadB64)}`;
}

/** Verifies signature + expiry and returns the encoded resource, or `null` for any tampered, expired, or
 * malformed token — deliberately a single undifferentiated failure mode (never distinguishes "bad
 * signature" from "expired" to a caller) so a client can't use error-message timing/shape to probe for
 * near-valid tokens. */
export function verifySignedDeepLink(token: string): DeepLinkResource | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, signature] = parts;
  if (!payloadB64 || !signature) return null;
  if (!timingSafeEqualString(signature, sign(payloadB64))) return null;

  let payload: DeepLinkPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload.exp !== "number" || Date.now() / 1000 > payload.exp) return null;
  if (typeof payload.resourceType !== "string" || !payload.resourceType) return null;
  if (typeof payload.resourceId !== "string" || !payload.resourceId) return null;
  return { resourceType: payload.resourceType, resourceId: payload.resourceId };
}
