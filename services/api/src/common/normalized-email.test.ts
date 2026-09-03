import { describe, expect, it } from "vitest";
import { NormalizedEmailSchema } from "./normalized-email";

describe("NormalizedEmailSchema", () => {
  it("trims and lowercases before validating, so callers can't bypass normalization by casing", () => {
    expect(NormalizedEmailSchema.parse("  Foo@Example.COM  ")).toBe("foo@example.com");
    expect(NormalizedEmailSchema.parse("ALREADY@LOWER.example")).toBe("already@lower.example");
  });

  it("still rejects a malformed address after normalization", () => {
    expect(() => NormalizedEmailSchema.parse("not-an-email")).toThrow();
    expect(() => NormalizedEmailSchema.parse("")).toThrow();
  });
});
