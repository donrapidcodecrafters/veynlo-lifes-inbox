import { describe, expect, it } from "vitest";
import { isWithinQuietHours } from "./quiet-hours";

function at(hour: number, minute: number): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

describe("isWithinQuietHours", () => {
  it("is false when no quiet hours are configured", () => {
    expect(isWithinQuietHours(null)).toBe(false);
    expect(isWithinQuietHours({ quietHoursStart: null, quietHoursEnd: null })).toBe(false);
  });

  it("handles a same-day window (e.g. 12:00-14:00)", () => {
    const prefs = { quietHoursStart: "12:00", quietHoursEnd: "14:00" };
    expect(isWithinQuietHours(prefs, at(13, 0))).toBe(true);
    expect(isWithinQuietHours(prefs, at(11, 59))).toBe(false);
    expect(isWithinQuietHours(prefs, at(14, 0))).toBe(false);
  });

  it("handles a window that wraps past midnight (e.g. 22:00-07:00)", () => {
    const prefs = { quietHoursStart: "22:00", quietHoursEnd: "07:00" };
    expect(isWithinQuietHours(prefs, at(23, 30))).toBe(true);
    expect(isWithinQuietHours(prefs, at(2, 0))).toBe(true);
    expect(isWithinQuietHours(prefs, at(12, 0))).toBe(false);
  });

  it("treats an identical start/end as always-off rather than always-on", () => {
    expect(isWithinQuietHours({ quietHoursStart: "09:00", quietHoursEnd: "09:00" }, at(9, 0))).toBe(false);
  });
});
