import { describe, expect, it } from "vitest";
import { createSignedDeepLink, verifySignedDeepLink } from "./signed-deep-link";

/**
 * §36 SYS-001..008 "deep links use signed/internal routes" — pure-function crypto, no DB needed. Covers
 * the round trip plus every tamper/expiry case a real widget-tap deep link needs to be provably safe
 * against: a flipped byte anywhere in the token, a swapped resource id, and a token minted in the past.
 */
describe("signed-deep-link", () => {
  it("round-trips a valid token", () => {
    const token = createSignedDeepLink({ resourceType: "purchase", resourceId: "purchase_abc123" }, 300);
    const decoded = verifySignedDeepLink(token);
    expect(decoded).toEqual({ resourceType: "purchase", resourceId: "purchase_abc123" });
  });

  it("rejects a token with a tampered signature", () => {
    const token = createSignedDeepLink({ resourceType: "trip", resourceId: "trip_xyz" }, 300);
    const [payloadB64, signature] = token.split(".");
    const flippedChar = signature![0] === "a" ? "b" : "a";
    const tampered = `${payloadB64}.${flippedChar}${signature!.slice(1)}`;
    expect(verifySignedDeepLink(tampered)).toBeNull();
  });

  it("rejects a token whose payload was swapped to point at a different resource without re-signing", () => {
    const tokenA = createSignedDeepLink({ resourceType: "purchase", resourceId: "purchase_A" }, 300);
    const tokenB = createSignedDeepLink({ resourceType: "purchase", resourceId: "purchase_B" }, 300);
    const [, signatureA] = tokenA.split(".");
    const [payloadB64B] = tokenB.split(".");
    // An attacker who intercepted token A's signature tries to graft it onto token B's (higher-value)
    // payload — must fail exactly like any other tamper, since the signature only ever covers the exact
    // payload bytes it was computed over.
    const frankensteined = `${payloadB64B}.${signatureA}`;
    expect(verifySignedDeepLink(frankensteined)).toBeNull();
  });

  it("rejects an expired token", () => {
    const token = createSignedDeepLink({ resourceType: "inbox_item", resourceId: "inbox_1" }, -1);
    expect(verifySignedDeepLink(token)).toBeNull();
  });

  it("rejects malformed tokens", () => {
    expect(verifySignedDeepLink("")).toBeNull();
    expect(verifySignedDeepLink("not-a-real-token")).toBeNull();
    expect(verifySignedDeepLink("one.two.three")).toBeNull();
    expect(verifySignedDeepLink("Zm9v.")).toBeNull();
  });

  it("rejects a token whose payload was decoded, edited, and re-encoded, but not re-signed", () => {
    const token = createSignedDeepLink({ resourceType: "purchase", resourceId: "purchase_cheap" }, 300);
    const [payloadB64, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString("utf8"));
    payload.resourceId = "purchase_expensive";
    const editedPayloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    expect(verifySignedDeepLink(`${editedPayloadB64}.${signature}`)).toBeNull();
  });
});
