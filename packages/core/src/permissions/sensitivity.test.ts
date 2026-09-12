import { describe, expect, it } from "vitest";
import { canCreateShareLink, DEFAULT_VISIBILITY_BY_SENSITIVITY, SensitivityTierSchema, type SensitivityTier } from "./sensitivity";

/**
 * Appendix C's rule about which sensitivity tiers may have an unauthenticated public link, which until now
 * had no test and — more to the point — no callers. It was exported, documented as the gate, and enforced
 * nowhere: every domain that needed the rule had restated it (DocumentsService's hardcoded tier comparison)
 * or hardcoded a blanket refusal (health-logistics, identity-records). All three were correct, which is
 * exactly why nothing surfaced it.
 *
 * The distinction the rule encodes: a public link is "anyone with the URL", while a resource grant targets
 * one named account. Grants stay unrestricted by tier on purpose; only the link is gated.
 */
describe("canCreateShareLink", () => {
  it("allows the two tiers that may be shared by public link", () => {
    expect(canCreateShareLink("standard")).toBe(true);
    expect(canCreateShareLink("sensitive")).toBe(true);
  });

  it("refuses the two tiers that may not", () => {
    expect(canCreateShareLink("highly_sensitive")).toBe(false);
    expect(canCreateShareLink("secret")).toBe(false);
  });

  it("has an answer for every tier in the enum, so a new tier cannot be silently permitted", () => {
    // A tier added to the schema without being considered here would default to `false` (refused), which
    // is the safe direction — but it would do so silently. This makes the set explicit.
    const tiers = SensitivityTierSchema.options;
    expect(tiers).toEqual(["standard", "sensitive", "highly_sensitive", "secret"]);
    const allowed = tiers.filter((t) => canCreateShareLink(t));
    expect(allowed).toEqual(["standard", "sensitive"]);
  });

  it("starts every tier private, including the two that may later be link-shared", () => {
    for (const tier of SensitivityTierSchema.options as SensitivityTier[]) {
      expect(DEFAULT_VISIBILITY_BY_SENSITIVITY[tier]).toBe("private");
    }
  });
});
