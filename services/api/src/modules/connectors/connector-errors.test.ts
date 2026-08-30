import { describe, expect, it } from "vitest";
import { classifyConnectorError, classifyPermissionHealth, parseGrantedScopes, extractRetryAfterMs } from "./connector-errors";

describe("classifyConnectorError", () => {
  it("classifies a 429 as rate_limited", () => {
    expect(classifyConnectorError({ status: 429 })).toBe("rate_limited");
    // googleapis' own error shape
    expect(classifyConnectorError({ code: 429 })).toBe("rate_limited");
    expect(classifyConnectorError({ response: { status: 429 } })).toBe("rate_limited");
  });

  it("classifies a 401/403 as reauth_required", () => {
    expect(classifyConnectorError({ status: 401 })).toBe("reauth_required");
    expect(classifyConnectorError({ status: 403 })).toBe("reauth_required");
    expect(classifyConnectorError({ code: 401 })).toBe("reauth_required");
  });

  it("classifies a 5xx as provider_outage", () => {
    expect(classifyConnectorError({ status: 500 })).toBe("provider_outage");
    expect(classifyConnectorError({ status: 503 })).toBe("provider_outage");
    expect(classifyConnectorError({ response: { status: 502 } })).toBe("provider_outage");
  });

  it("falls back to degraded for a 404 or any other unclassified status", () => {
    expect(classifyConnectorError({ status: 404 })).toBe("degraded");
    expect(classifyConnectorError({ status: 400 })).toBe("degraded");
  });

  it("falls back to degraded for a plain Error with no status (network failure, genuine bug)", () => {
    expect(classifyConnectorError(new Error("ECONNREFUSED"))).toBe("degraded");
    expect(classifyConnectorError(new Error())).toBe("degraded");
  });

  it("falls back to degraded for a non-numeric err.code (Node system error codes are strings)", () => {
    expect(classifyConnectorError({ code: "ETIMEDOUT" })).toBe("degraded");
  });
});

describe("parseGrantedScopes", () => {
  it("splits a space-separated OAuth scope string", () => {
    expect(parseGrantedScopes("https://www.googleapis.com/auth/gmail.readonly")).toEqual(["https://www.googleapis.com/auth/gmail.readonly"]);
    expect(parseGrantedScopes("offline_access Calendars.ReadWrite")).toEqual(["offline_access", "Calendars.ReadWrite"]);
  });

  it("returns an empty array for a missing/empty scope (a token response that omits it, not a real signal)", () => {
    expect(parseGrantedScopes(undefined)).toEqual([]);
    expect(parseGrantedScopes(null)).toEqual([]);
    expect(parseGrantedScopes("")).toEqual([]);
  });
});

describe("classifyPermissionHealth", () => {
  it("is healthy when every required scope was granted", () => {
    expect(classifyPermissionHealth(["gmail.readonly", "extra.scope"], ["gmail.readonly"])).toBe("healthy");
  });

  it("is permission_reduced when a required scope is missing from what was granted", () => {
    expect(classifyPermissionHealth(["offline_access"], ["offline_access", "Calendars.ReadWrite"])).toBe("permission_reduced");
  });

  it("defaults to healthy when nothing was ever captured — a connection from before this existed, or a token response that omitted scope, has no real signal to act on", () => {
    expect(classifyPermissionHealth([], ["gmail.readonly"])).toBe("healthy");
  });
});

describe("extractRetryAfterMs", () => {
  it("reads a directly-attached retryAfterHeader (the Microsoft adapters' raw-fetch shape)", () => {
    expect(extractRetryAfterMs({ retryAfterHeader: "30" })).toBe(30_000);
  });

  it("reads a Headers-like object's retry-after header", () => {
    const err = { response: { headers: new Headers({ "retry-after": "120" }) } };
    expect(extractRetryAfterMs(err)).toBe(120_000);
  });

  it("reads a plain header-map object's retry-after header, case-insensitively", () => {
    expect(extractRetryAfterMs({ response: { headers: { "Retry-After": "5" } } })).toBe(5_000);
  });

  it("caps an absurdly large value rather than letting a provider park a connection indefinitely", () => {
    expect(extractRetryAfterMs({ retryAfterHeader: "999999" })).toBe(60 * 60 * 1000);
  });

  it("returns null for a missing/non-numeric/zero header rather than fabricating a wait", () => {
    expect(extractRetryAfterMs({ retryAfterHeader: undefined })).toBeNull();
    expect(extractRetryAfterMs({ retryAfterHeader: "not-a-number" })).toBeNull();
    expect(extractRetryAfterMs({ retryAfterHeader: "0" })).toBeNull();
    expect(extractRetryAfterMs(new Error("network failure"))).toBeNull();
  });
});
