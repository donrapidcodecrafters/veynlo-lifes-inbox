import { describe, expect, it } from "vitest";
import { isWithinQuietHours } from "./quiet-hours";

/** Builds a UTC instant at the given UTC hour/minute — tests must be independent of the machine's own local timezone. */
function utcAt(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 0, 1, hour, minute, 0, 0));
}

describe("isWithinQuietHours", () => {
  it("is false when no quiet hours are configured", () => {
    expect(isWithinQuietHours(null)).toBe(false);
    expect(isWithinQuietHours({ quietHoursStart: null, quietHoursEnd: null })).toBe(false);
  });

  it("handles a same-day window (e.g. 12:00-14:00) in UTC", () => {
    const prefs = { quietHoursStart: "12:00", quietHoursEnd: "14:00" };
    expect(isWithinQuietHours(prefs, utcAt(13, 0), "UTC")).toBe(true);
    expect(isWithinQuietHours(prefs, utcAt(11, 59), "UTC")).toBe(false);
    expect(isWithinQuietHours(prefs, utcAt(14, 0), "UTC")).toBe(false);
  });

  it("handles a window that wraps past midnight (e.g. 22:00-07:00) in UTC", () => {
    const prefs = { quietHoursStart: "22:00", quietHoursEnd: "07:00" };
    expect(isWithinQuietHours(prefs, utcAt(23, 30), "UTC")).toBe(true);
    expect(isWithinQuietHours(prefs, utcAt(2, 0), "UTC")).toBe(true);
    expect(isWithinQuietHours(prefs, utcAt(12, 0), "UTC")).toBe(false);
  });

/**
   * Found by the Mac while testing the Notifications toggles: nothing validated these strings at any layer,
   * so "notatime" reached the database intact — and this function did not throw or disable quiet hours when
   * it read it back. `"notatime".split(":").map(Number)` is `[NaN]`, and `NaN ?? 0` is NaN, because nullish
   * coalescing only catches null and undefined. Every comparison against NaN is false, so the wrap-past-
   * midnight branch was taken and the window silently became 00:00 to whatever the END time said.
   *
   * Silently muting someone's notifications from midnight is worse than either alternative: worse than
   * rejecting the input, and worse than crashing, because nothing anywhere says it happened.
   */
  it("treats an unparseable time as no quiet hours at all, rather than inventing a window from midnight", () => {
    const garbageStart = { quietHoursStart: "notatime", quietHoursEnd: "07:00" };
    // 03:00 sits inside the phantom 00:00-07:00 window this used to compute.
    expect(isWithinQuietHours(garbageStart, utcAt(3, 0), "UTC")).toBe(false);
    expect(isWithinQuietHours(garbageStart, utcAt(9, 0), "UTC")).toBe(false);

    const garbageEnd = { quietHoursStart: "22:00", quietHoursEnd: "" };
    expect(isWithinQuietHours(garbageEnd, utcAt(23, 0), "UTC")).toBe(false);

    // Shapes that parse to a number but are not a time of day.
    expect(isWithinQuietHours({ quietHoursStart: "25:00", quietHoursEnd: "07:00" }, utcAt(3, 0), "UTC")).toBe(false);
    expect(isWithinQuietHours({ quietHoursStart: "12", quietHoursEnd: "14:00" }, utcAt(13, 0), "UTC")).toBe(false);
    expect(isWithinQuietHours({ quietHoursStart: "12:99", quietHoursEnd: "14:00" }, utcAt(13, 0), "UTC")).toBe(false);
  });

  it("treats an identical start/end as always-off rather than always-on", () => {
    expect(isWithinQuietHours({ quietHoursStart: "09:00", quietHoursEnd: "09:00" }, utcAt(9, 0), "UTC")).toBe(false);
  });

  it("defaults to UTC when no timezone is given", () => {
    const prefs = { quietHoursStart: "22:00", quietHoursEnd: "07:00" };
    expect(isWithinQuietHours(prefs, utcAt(23, 30))).toBe(true);
    expect(isWithinQuietHours(prefs, utcAt(12, 0))).toBe(false);
  });

  it("evaluates quiet hours in the user's own timezone, not the server's", () => {
    // 08:00 UTC is 00:00 in America/Los_Angeles (UTC-8 in January) — inside a 22:00-07:00 LA-local quiet
    // window, even though 08:00 UTC is broad daylight and would NOT be quiet under a UTC-only evaluation.
    const prefs = { quietHoursStart: "22:00", quietHoursEnd: "07:00" };
    const eightAmUtc = utcAt(8, 0);
    expect(isWithinQuietHours(prefs, eightAmUtc, "America/Los_Angeles")).toBe(true);
    expect(isWithinQuietHours(prefs, eightAmUtc, "UTC")).toBe(false);

    // The reverse: 15:00 UTC is broad daylight (07:00) in Los Angeles — right at the window's own end
    // boundary, so no longer quiet there — while it's within a same-hour UTC window for comparison.
    const fifteenUtc = utcAt(15, 0);
    expect(isWithinQuietHours(prefs, fifteenUtc, "America/Los_Angeles")).toBe(false);
  });

  it("falls back to UTC for an unrecognized timezone rather than throwing", () => {
    const prefs = { quietHoursStart: "22:00", quietHoursEnd: "07:00" };
    expect(() => isWithinQuietHours(prefs, utcAt(23, 30), "Not/A_Real_Zone")).not.toThrow();
    expect(isWithinQuietHours(prefs, utcAt(23, 30), "Not/A_Real_Zone")).toBe(true);
  });
});
