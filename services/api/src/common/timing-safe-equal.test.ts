import { describe, expect, it } from "vitest";
import { timingSafeEqualString } from "./timing-safe-equal";

/**
 * The RevenueCat and inbound-email webhook auth checks used to be a plain `!==` on a shared-secret
 * string — a timing side-channel (V8's `===` short-circuits on the first mismatched byte). This is a
 * behavioral test of the replacement, not a timing measurement (timing itself isn't practical to assert
 * in a unit test) — it just proves the constant-time comparison is still functionally correct for every
 * input shape that matters, including the ones a naive rewrite could get wrong (undefined, empty, and
 * differing-length inputs, which `crypto.timingSafeEqual` throws on if not guarded).
 */
describe("timingSafeEqualString", () => {
  it("matches identical strings", () => {
    expect(timingSafeEqualString("shared-secret-123", "shared-secret-123")).toBe(true);
  });

  it("rejects a mismatched string of the same length", () => {
    expect(timingSafeEqualString("shared-secret-123", "shared-secret-124")).toBe(false);
  });

  it("rejects strings of different lengths without throwing", () => {
    expect(timingSafeEqualString("short", "a-much-longer-secret")).toBe(false);
  });

  it("rejects when either side is undefined", () => {
    expect(timingSafeEqualString(undefined, "shared-secret-123")).toBe(false);
    expect(timingSafeEqualString("shared-secret-123", undefined)).toBe(false);
    expect(timingSafeEqualString(undefined, undefined)).toBe(false);
  });

  it("rejects empty strings even against an empty expected value", () => {
    expect(timingSafeEqualString("", "")).toBe(false);
  });
});
