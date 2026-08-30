import { describe, expect, it } from "vitest";
import { classifyConnectorError, classifyPermissionHealth, parseGrantedScopes } from "./connector-errors";

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
