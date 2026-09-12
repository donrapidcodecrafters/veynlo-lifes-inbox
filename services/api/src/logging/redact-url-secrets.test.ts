import { describe, expect, it } from "vitest";
import { redactUrlSecrets, REDACTED_SEGMENT } from "./redact-url-secrets";

/**
 * Three public endpoints carry their secret in the URL path, where pino's `redact` cannot reach it —
 * `redact` matches object paths and a URL is one opaque string. Proven against the running API before the
 * fix: a share-redemption request logged `"url":"/v1/share/PROVE-TOKEN-IN-LOGS-1788845080/access"` in full.
 *
 * For all three the token IS the trust boundary, so log access alone was enough to redeem a link.
 */
describe("redactUrlSecrets", () => {
  it("removes a share-link token but keeps the route shape", () => {
    expect(redactUrlSecrets("/v1/share/abc123SECRETtoken/access")).toBe(`/v1/share/${REDACTED_SEGMENT}/access`);
  });

  it("removes a caregiver day-pass token", () => {
    expect(redactUrlSecrets("/v1/day-passes/dp_live_secret/access")).toBe(`/v1/day-passes/${REDACTED_SEGMENT}/access`);
  });

  it("removes a legacy-release token, which has no trailing segment", () => {
    expect(redactUrlSecrets("/v1/legacy-release-redeem/lr_secret_token")).toBe(`/v1/legacy-release-redeem/${REDACTED_SEGMENT}`);
  });

  it("leaves an ordinary URL completely alone", () => {
    for (const url of ["/v1/purchases", "/v1/documents/doc_123", "/v1/timeline?before=2026-01-01", "/health"]) {
      expect(redactUrlSecrets(url)).toBe(url);
    }
  });

  it("does not redact a resource id that merely resembles one of these routes", () => {
    // `/v1/shared-with-me` must not be mistaken for `/v1/share/<token>` by a loose prefix match.
    expect(redactUrlSecrets("/v1/shared-with-me")).toBe("/v1/shared-with-me");
  });

  it("keeps the query string, which carries no secret for these routes", () => {
    expect(redactUrlSecrets("/v1/share/tok/access?utm=email")).toBe(`/v1/share/${REDACTED_SEGMENT}/access?utm=email`);
  });

  it("survives an undefined url rather than throwing inside a log serializer", () => {
    // A serializer that throws takes the log line — and potentially the request — with it.
    expect(redactUrlSecrets(undefined)).toBeUndefined();
    expect(redactUrlSecrets("")).toBe("");
  });

  it("never returns the original token anywhere in the output", () => {
    const token = "s3cret-token-value-that-must-not-survive";
    for (const url of [`/v1/share/${token}/access`, `/v1/day-passes/${token}/access`, `/v1/legacy-release-redeem/${token}`]) {
      expect(redactUrlSecrets(url)).not.toContain(token);
    }
  });
});
