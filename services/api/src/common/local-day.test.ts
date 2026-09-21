import { describe, expect, it } from "vitest";
import { localDayWindow } from "./local-day";

/**
 * The "Today" views bounded their window by the UTC calendar day while `users.timezone` sat populated and
 * unused. In America/New_York that means the day rolls over at 20:00 local, so for the last four hours of
 * every day the screen showed tomorrow's items and hid today's.
 */
const NY = "America/New_York";

/**
 * Formats an instant as wall-clock time in a zone, so assertions read as what a user would see.
 *
 * The `, 24:00` → `, 00:00` fix is the same engine quirk local-day.ts guards internally: with
 * `hour12: false`, V8 renders midnight as hour 24. It bit this helper first — five assertions failed on
 * `'2026-09-07, 24:00'` vs `'2026-09-07, 00:00'` while every date in them was already correct.
 */
const wall = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(", 24:", ", 00:");

describe("localDayWindow", () => {
  it("bounds the user's local day, not the UTC one", () => {
    // 02:00 UTC on the 8th is 22:00 on the 7th in New York — the exact window where the old UTC-based
    // boundary showed the wrong day.
    const now = new Date("2026-09-08T02:00:00Z");
    const { startOfDay, endOfDay } = localDayWindow(now, NY);

    expect(wall(startOfDay, NY)).toBe("2026-09-07, 00:00");
    expect(wall(endOfDay, NY)).toBe("2026-09-08, 00:00");
    // In UTC terms that window is 04:00 on the 7th to 04:00 on the 8th — nothing like the UTC day.
    expect(startOfDay.toISOString()).toBe("2026-09-07T04:00:00.000Z");
    expect(now >= startOfDay && now < endOfDay).toBe(true);
  });

  it("is what the old UTC computation would have got wrong", () => {
    const now = new Date("2026-09-08T02:00:00Z");
    const utcStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const { startOfDay } = localDayWindow(now, NY);
    // The old boundary called it the 8th; the user's calendar says the 7th.
    expect(utcStart.toISOString()).toBe("2026-09-08T00:00:00.000Z");
    expect(wall(startOfDay, NY).startsWith("2026-09-07")).toBe(true);
  });

  it("gives a 23-hour day when the clocks go forward", () => {
    // US DST begins 2026-03-08. That local day is 23 hours long.
    const during = new Date("2026-03-08T16:00:00Z"); // noon EDT
    const { startOfDay, endOfDay } = localDayWindow(during, NY);
    expect(wall(startOfDay, NY)).toBe("2026-03-08, 00:00");
    expect(wall(endOfDay, NY)).toBe("2026-03-09, 00:00");
    expect((endOfDay.getTime() - startOfDay.getTime()) / 3_600_000).toBe(23);
  });

  it("gives a 25-hour day when the clocks go back", () => {
    // US DST ends 2026-11-01.
    const during = new Date("2026-11-01T16:00:00Z");
    const { startOfDay, endOfDay } = localDayWindow(during, NY);
    expect(wall(startOfDay, NY)).toBe("2026-11-01, 00:00");
    expect(wall(endOfDay, NY)).toBe("2026-11-02, 00:00");
    expect((endOfDay.getTime() - startOfDay.getTime()) / 3_600_000).toBe(25);
  });

  it("handles a zone ahead of UTC, where the local day starts before the UTC one", () => {
    // 22:00 UTC on the 7th is 10:00 on the 8th in Auckland.
    const now = new Date("2026-09-07T22:00:00Z");
    const { startOfDay, endOfDay } = localDayWindow(now, "Pacific/Auckland");
    expect(wall(startOfDay, "Pacific/Auckland")).toBe("2026-09-08, 00:00");
    expect(now >= startOfDay && now < endOfDay).toBe(true);
  });

  it("handles a half-hour offset zone", () => {
    const now = new Date("2026-09-07T20:00:00Z"); // 01:30 on the 8th in Kolkata
    const { startOfDay, endOfDay } = localDayWindow(now, "Asia/Kolkata");
    expect(wall(startOfDay, "Asia/Kolkata")).toBe("2026-09-08, 00:00");
    expect(startOfDay.toISOString()).toBe("2026-09-07T18:30:00.000Z");
    expect(now >= startOfDay && now < endOfDay).toBe(true);
  });

  it("falls back to UTC for a missing or malformed zone rather than throwing", () => {
    const now = new Date("2026-09-08T02:00:00Z");
    for (const zone of [null, undefined, "", "Not/AZone"]) {
      const { startOfDay, endOfDay } = localDayWindow(now, zone);
      expect(startOfDay.toISOString()).toBe("2026-09-08T00:00:00.000Z");
      expect(endOfDay.toISOString()).toBe("2026-09-09T00:00:00.000Z");
    }
  });

  it("always contains the instant it was asked about, across a full day of instants in several zones", () => {
    // The property that actually matters: whatever "now" is, the user's today must include it.
    for (const zone of [NY, "Pacific/Auckland", "Asia/Kolkata", "Europe/London", "UTC", "America/Los_Angeles"]) {
      for (let hour = 0; hour < 24; hour++) {
        const now = new Date(Date.UTC(2026, 8, 7, hour, 30));
        const { startOfDay, endOfDay } = localDayWindow(now, zone);
        expect(now >= startOfDay, `${zone} @ ${hour}:30Z — start`).toBe(true);
        expect(now < endOfDay, `${zone} @ ${hour}:30Z — end`).toBe(true);
      }
    }
  });
});
