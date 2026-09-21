import { describe, expect, it } from "vitest";
import { localWallClockToInstant } from "./local-day";

/**
 * A wall-clock time given with a fixed UTC offset instead of a zone name.
 *
 * `Intl` understands only IANA zones, and `zoneOffsetMs` turned anything it rejected into 0 — silently
 * UTC. That is a reasonable fallback for a malformed stored value (a screen should not go down over one),
 * but it is the wrong answer for a caller holding a real, unambiguous offset: the time came back WRONG
 * rather than as an error.
 *
 * Found by a test, not in review. schema.org reservation markup states "2026-04-15T18:30:00-07:00", and
 * passing that offset through filed an 18:30 departure as 18:30Z — seven hours out. A flight filed at the
 * wrong hour is worse than one not filed at all, because somebody plans around it.
 */
const at = (year: number, month: number, day: number, hour: number, minute: number) => ({ year, month, day, hour, minute });

describe("a fixed UTC offset", () => {
  it("reads a negative offset", () => {
    // 18:30 at -07:00 is 01:30 UTC the following day.
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "-07:00").toISOString()).toBe("2026-04-16T01:30:00.000Z");
  });

  it("reads a positive offset", () => {
    expect(localWallClockToInstant(at(2026, 4, 15, 9, 0), "+02:00").toISOString()).toBe("2026-04-15T07:00:00.000Z");
  });

  it("reads an offset with minutes", () => {
    // India is +05:30, Nepal +05:45, Chatham +12:45. An hours-only reader is wrong for all three.
    expect(localWallClockToInstant(at(2026, 4, 15, 12, 0), "+05:30").toISOString()).toBe("2026-04-15T06:30:00.000Z");
    expect(localWallClockToInstant(at(2026, 4, 15, 12, 0), "+05:45").toISOString()).toBe("2026-04-15T06:15:00.000Z");
  });

  it("reads an offset written without its colon", () => {
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "-0700").toISOString()).toBe("2026-04-16T01:30:00.000Z");
  });

  it("treats +00:00 and Z-equivalent as UTC", () => {
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "+00:00").toISOString()).toBe("2026-04-15T18:30:00.000Z");
  });

  it("still reads a real zone name, including across a DST boundary", () => {
    // The whole point of the existing implementation, which this must not disturb. 2026-03-08 is the US
    // spring-forward, and 02:30 does not exist that morning in New York.
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "America/Los_Angeles").toISOString()).toBe("2026-04-16T01:30:00.000Z");
    expect(localWallClockToInstant(at(2026, 1, 15, 12, 0), "America/New_York").toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(localWallClockToInstant(at(2026, 7, 15, 12, 0), "America/New_York").toISOString()).toBe("2026-07-15T16:00:00.000Z");
  });

  it("falls back to UTC for something that is neither, rather than throwing", () => {
    // A malformed stored value must not take a screen down — the existing contract, unchanged.
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "Not/AZone").toISOString()).toBe("2026-04-15T18:30:00.000Z");
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "").toISOString()).toBe("2026-04-15T18:30:00.000Z");
  });

  it("refuses an impossible offset instead of computing a wild instant", () => {
    // The real range is -12:00..+14:00. "+99:00" is not an offset anyone has; treating it as one would move
    // a time by four days.
    expect(localWallClockToInstant(at(2026, 4, 15, 18, 30), "+99:00").toISOString()).toBe("2026-04-15T18:30:00.000Z");
  });
});
