import { describe, expect, it } from "vitest";
import { importPKCS8 } from "jose";
import { looksLikePkcs8 } from "./env";

/**
 * `isAppleSignInConfigured()` used to be `Boolean(clientId && teamId && keyId && privateKey)` — a pure
 * presence check on four strings.
 *
 * Found on the Mac's environment during the audit: `APPLE_PRIVATE_KEY` was **27 characters** — exactly
 * `-----BEGIN PRIVATE KEY-----` with no body. A real ES256 .p8 is several hundred. That value passed the
 * presence check, so the API advertised Apple sign-in as configured, the client rendered the "Sign in
 * with Apple" button, and pressing it reached `importPKCS8()`, which throws. Unhandled, that becomes
 * `500 INTERNAL_ERROR` with `retryable: true` — wrong twice over: a configuration fault reported as
 * transient, and a retry that can never succeed.
 *
 * The first test pins the actual jose behaviour rather than assuming it, because the whole fix rests on
 * the claim that these values throw.
 */
describe("Apple private key shape", () => {
  const REAL_SHAPED = "-----BEGIN PRIVATE KEY-----\n" + "A".repeat(240) + "\n-----END PRIVATE KEY-----";

  it("jose really does reject the values that were passing the old check", async () => {
    for (const bad of ["-----BEGIN PRIVATE KEY-----", "----", "not-a-key", ""]) {
      await expect(importPKCS8(bad, "ES256"), JSON.stringify(bad)).rejects.toThrow();
    }
  });

  it("rejects the exact placeholder that was found in a real environment", () => {
    expect(looksLikePkcs8("-----BEGIN PRIVATE KEY-----")).toBe(false);
  });

  it("rejects absent, empty and obviously-not-a-key values", () => {
    expect(looksLikePkcs8(undefined)).toBe(false);
    expect(looksLikePkcs8("")).toBe(false);
    expect(looksLikePkcs8("----")).toBe(false);
    expect(looksLikePkcs8("not-a-key")).toBe(false);
  });

  it("rejects a PEM envelope whose body is too short to be a real key", () => {
    // The failure mode is a header with nothing meaningful after it, not a missing header.
    expect(looksLikePkcs8("-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----")).toBe(false);
  });

  it("accepts a properly shaped PKCS#8 PEM", () => {
    expect(looksLikePkcs8(REAL_SHAPED)).toBe(true);
  });

  it("tolerates surrounding whitespace, since .env values get pasted", () => {
    expect(looksLikePkcs8(`\n  ${REAL_SHAPED}  \n`)).toBe(true);
  });

  it("is a shape check, not a crypto check — and that is deliberate", async () => {
    // This value passes looksLikePkcs8 and still is not a usable key. That is why
    // generateAppleClientSecret ALSO catches importPKCS8's failure and degrades to
    // OAuthNotConfiguredError: the predicate is synchronous and cannot parse a key, so the two layers
    // cover different halves of the same problem.
    expect(looksLikePkcs8(REAL_SHAPED)).toBe(true);
    await expect(importPKCS8(REAL_SHAPED, "ES256")).rejects.toThrow();
  });
});
