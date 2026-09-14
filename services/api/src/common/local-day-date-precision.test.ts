import { describe, expect, it } from "vitest";
import { localDateIso, localDayWindow, localWallClockToInstant, temporalFallsOnLocalDay } from "./local-day";
import { temporalToSortDate } from "../modules/ingestion/temporal.util";

/**
 * A date-only value must fall on the day it is dated, for a user who is not on UTC.
 *
 * DEF-102's live sibling. That defect was a TIME being dropped; this is what happened to the values that
 * legitimately have no time — an all-day event, a bill due "on the 12th", a task with a date and no hour.
 *
 * Their sort key is UTC midnight, and every "today" query compared it against a window built from the
 * owner's timezone. Those do not line up: Chicago's September 12th begins at 05:00Z, and an event dated
 * the 12th sorts at 00:00Z — five hours before its own day starts, and inside the window for the 11th. So
 * it appeared a whole day early for every user in the Americas, and a day late east of UTC.
 *
 * The first version of this file asserted on `temporalToSortDate` and failed for Chicago, Los Angeles and
 * Auckland while passing for UTC. The sort key is deliberately unchanged — a stored instant that depends
 * on a mutable user attribute is its own defect — so the fix is that a date-only value is now compared BY
 * DATE, and these assert that contract.
 */
describe("date-only values fall on their own local day", () => {
  const DATE = "2026-09-12";
  const dateOnly = { precision: "date" as const, instantUtc: null, date: DATE, timezone: null, sourceText: null };
  /**
   * Midday on DATE **in the given zone**.
   *
   * Not noon UTC. Noon UTC on the 12th is already 00:00 on the 13th in Auckland, so anchoring in UTC asks
   * a far-eastern zone about a day its user is no longer in — which an earlier version of this file did,
   * and then reported the correct answer as a failure.
   */
  const middayIn = (zone: string) =>
    localWallClockToInstant({ year: 2026, month: 9, day: 12, hour: 12, minute: 0 }, zone);

  const onItsOwnDay = (zone: string) => {
    const at = middayIn(zone);
    return temporalFallsOnLocalDay(dateOnly, localDayWindow(at, zone), localDateIso(at, zone));
  };

  for (const zone of ["UTC", "America/Chicago", "America/Los_Angeles", "Pacific/Auckland", "Asia/Kolkata"]) {
    it(`lands on its own day in ${zone}`, () => {
      expect(onItsOwnDay(zone)).toBe(true);
    });
  }

  it("does not leak into the neighbouring local days", () => {
    for (const zone of ["America/Chicago", "Pacific/Auckland"]) {
      for (const day of [11, 13]) {
        const at = localWallClockToInstant({ year: 2026, month: 9, day, hour: 12, minute: 0 }, zone);
        expect(temporalFallsOnLocalDay(dateOnly, localDayWindow(at, zone), localDateIso(at, zone))).toBe(false);
      }
    }
  });

  it("still compares a real instant against the window, not against a date", () => {
    // A 23:30 Chicago appointment is on the 12th locally but the 13th in UTC. It must follow the window,
    // which is the whole reason instants and dates cannot share one comparison.
    const lateEvening = {
      precision: "instant" as const,
      instantUtc: "2026-09-13T04:30:00Z",
      date: null,
      timezone: "America/Chicago",
      sourceText: null,
    };
    const at = new Date("2026-09-12T20:00:00Z");
    const window = localDayWindow(at, "America/Chicago");
    expect(temporalFallsOnLocalDay(lateEvening, window, localDateIso(at, "America/Chicago"))).toBe(true);
  });

  it("the sort key itself is left alone, and is still UTC midnight", () => {
    // Recorded rather than assumed: the fix is in the comparison, not in the stored value. Changing the
    // sort key would tie a stored instant to a user's current timezone and need a backfill every time
    // someone travelled.
    expect(temporalToSortDate(dateOnly)!.toISOString()).toBe(`${DATE}T00:00:00.000Z`);
  });
});
