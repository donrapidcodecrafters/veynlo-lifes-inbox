import { describe, expect, it } from "vitest";
import { amountsConflict, datesConflict } from "./ingestion.service";

describe("amountsConflict", () => {
  it("flags two different non-null amounts as conflicting", () => {
    expect(amountsConflict(5000, 7500)).toBe(true);
  });

  it("does not flag equal amounts", () => {
    expect(amountsConflict(5000, 5000)).toBe(false);
  });

  it("does not flag when either side is null — nothing to disagree with yet", () => {
    expect(amountsConflict(null, 7500)).toBe(false);
    expect(amountsConflict(5000, null)).toBe(false);
    expect(amountsConflict(null, null)).toBe(false);
  });
});

describe("datesConflict", () => {
  it("flags dates more than a day apart", () => {
    expect(datesConflict(new Date("2026-09-15T00:00:00Z"), new Date("2026-09-20T00:00:00Z"))).toBe(true);
  });

  it("does not flag dates within a day of each other — timezone/precision noise, not a real conflict", () => {
    expect(datesConflict(new Date("2026-09-15T00:00:00Z"), new Date("2026-09-15T23:00:00Z"))).toBe(false);
  });

  it("does not flag when either side is null", () => {
    expect(datesConflict(null, new Date("2026-09-15T00:00:00Z"))).toBe(false);
    expect(datesConflict(new Date("2026-09-15T00:00:00Z"), null)).toBe(false);
  });
});
