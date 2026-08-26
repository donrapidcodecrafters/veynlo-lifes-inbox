import { describe, expect, it } from "vitest";
import { resolveCapability, type EntitlementLike } from "./plans";

const now = new Date("2026-06-01T00:00:00Z");

describe("resolveCapability", () => {
  it("defaults to the free plan when no entitlement is active", () => {
    expect(resolveCapability([], "ask_queries_per_day", now)).toBe(10);
    expect(resolveCapability([], "purchases_returns_tracking", now)).toBe(false);
  });

  it("ignores entitlements outside their effective window", () => {
    const expired: EntitlementLike[] = [
      { planKey: "family", effectiveFrom: "2020-01-01", effectiveTo: "2020-06-01" },
    ];
    expect(resolveCapability(expired, "household_members_max", now)).toBe(1); // falls back to free
  });

  it("takes the highest-value plan when multiple entitlements are simultaneously active", () => {
    const stacked: EntitlementLike[] = [
      { planKey: "plus", effectiveFrom: "2026-01-01", effectiveTo: null },
      { planKey: "family", effectiveFrom: "2026-01-01", effectiveTo: null },
    ];
    expect(resolveCapability(stacked, "household_members_max", now)).toBe(6);
  });

  it("treats null (unlimited) as always winning over a finite quota", () => {
    const mixed: EntitlementLike[] = [
      { planKey: "plus", effectiveFrom: "2026-01-01", effectiveTo: null },
      { planKey: "pro_agent", effectiveFrom: "2026-01-01", effectiveTo: null },
    ];
    expect(resolveCapability(mixed, "ask_queries_per_day", now)).toBeNull();
  });

  it("accepts raw Date objects the same as ISO strings (DB rows vs. validated entities)", () => {
    const withDates: EntitlementLike[] = [
      { planKey: "family", effectiveFrom: new Date("2026-01-01"), effectiveTo: null },
    ];
    expect(resolveCapability(withDates, "family_school_sharing", now)).toBe(true);
  });
});
