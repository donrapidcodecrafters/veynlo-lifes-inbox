import { describe, expect, it } from "vitest";
import { classifyConnectorError } from "./connector-errors";

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
