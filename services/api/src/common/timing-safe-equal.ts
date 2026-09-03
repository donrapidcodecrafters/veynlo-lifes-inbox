import { timingSafeEqual } from "node:crypto";

/**
 * A plain `===` on a shared-secret bearer value (RevenueCat's webhook auth header, the inbound-email
 * webhook secret) is a timing side-channel — string comparison in V8 short-circuits on the first
 * mismatched byte, so how long the comparison takes leaks how many leading characters of the guess were
 * correct, letting an attacker recover the secret byte-by-byte over enough requests. Unlike Stripe's
 * webhook signature (verified via the Stripe SDK's own constant-time HMAC compare), these are plain
 * shared-secret equality checks with nothing else guarding them. `node:crypto`'s `timingSafeEqual`
 * requires equal-length buffers, so an early length check is unavoidable — that alone leaks only the
 * secret's length, a far smaller leak than leaking it character-by-character.
 */
export function timingSafeEqualString(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
