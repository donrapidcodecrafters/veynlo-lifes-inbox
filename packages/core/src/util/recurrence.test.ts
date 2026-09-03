import { describe, expect, it } from "vitest";
import { expandOccurrences, nextMileageDue, nextMileageOrCalendarDue, nextMileageOrCalendarCalendarDate, type RecurrenceRule } from "./recurrence";

describe("expandOccurrences", () => {
  it("expands a daily rule at the given interval", () => {
    const rule: RecurrenceRule = { kind: "daily", interval: 2 };
    const dates = expandOccurrences(rule, "2026-09-01", { from: "2026-09-01", count: 4 });
    expect(dates).toEqual(["2026-09-01", "2026-09-03", "2026-09-05", "2026-09-07"]);
  });

  it("expands a weekly rule on the anchor's weekday when daysOfWeek is empty", () => {
    // 2026-09-01 is a Tuesday.
    const rule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    const dates = expandOccurrences(rule, "2026-09-01", { from: "2026-09-01", count: 3 });
    expect(dates).toEqual(["2026-09-01", "2026-09-08", "2026-09-15"]);
  });

  it("expands a weekly rule across multiple explicit weekdays, never before the anchor", () => {
    // Anchor is Tuesday 2026-09-01; Mon/Wed/Fri of the same week, then the next interval's week.
    const rule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [1, 3, 5] }; // Mon, Wed, Fri
    const dates = expandOccurrences(rule, "2026-09-01", { from: "2026-09-01", count: 5 });
    // Monday 8/31 is before the anchor and must be excluded; Wed 9/2 and Fri 9/4 are this week.
    expect(dates).toEqual(["2026-09-02", "2026-09-04", "2026-09-07", "2026-09-09", "2026-09-11"]);
  });

  it("expands a monthly rule, defaulting dayOfMonth to the anchor's day and clamping short months", () => {
    const rule: RecurrenceRule = { kind: "monthly", interval: 1, dayOfMonth: 31 };
    const dates = expandOccurrences(rule, "2026-01-31", { from: "2026-01-31", count: 4 });
    // Feb 2026 has 28 days, Apr has 30 — both clamp instead of rolling into the next month.
    expect(dates).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]);
  });

  it("expands a yearly rule at the given interval", () => {
    const rule: RecurrenceRule = { kind: "yearly", interval: 2 };
    const dates = expandOccurrences(rule, "2024-02-29", { from: "2024-02-29", count: 3 });
    // Leap-year anchor clamps onto non-leap years the same way monthly does.
    expect(dates).toEqual(["2024-02-29", "2026-02-28", "2028-02-29"]);
  });

  it("expands 'nth weekday of the month' (e.g. 2nd Tuesday)", () => {
    const rule: RecurrenceRule = { kind: "nth_weekday", interval: 1, weekday: 2, nth: 2 }; // 2nd Tuesday
    const dates = expandOccurrences(rule, "2026-09-08", { from: "2026-09-08", count: 3 });
    expect(dates).toEqual(["2026-09-08", "2026-10-13", "2026-11-10"]);
  });

  it("expands 'last weekday of the month' when nth is -1", () => {
    const rule: RecurrenceRule = { kind: "nth_weekday", interval: 1, weekday: 5, nth: -1 }; // last Friday
    const dates = expandOccurrences(rule, "2026-09-25", { from: "2026-09-25", count: 2 });
    expect(dates).toEqual(["2026-09-25", "2026-10-30"]);
  });

  it("expands 'every N business days', skipping weekends", () => {
    const rule: RecurrenceRule = { kind: "business_day", interval: 1 };
    // 2026-09-04 is a Friday; the next business day is Monday, not Saturday/Sunday.
    const dates = expandOccurrences(rule, "2026-09-04", { from: "2026-09-04", count: 3 });
    expect(dates).toEqual(["2026-09-04", "2026-09-07", "2026-09-08"]);
  });

  it("shifts a weekend occurrence to the nearest weekday when weekendAdjustment is set", () => {
    // 2026-08-29 is a Saturday; the adjustment shifts it backward to Friday 8/28, which is why `from`
    // starts a day before the anchor here — a `from` equal to the (unshifted) anchor would exclude the
    // shifted-earlier date, which is correct window behavior, not a bug (covered by its own test below).
    const rule: RecurrenceRule = { kind: "daily", interval: 7, weekendAdjustment: "nearest_weekday" };
    const dates = expandOccurrences(rule, "2026-08-29", { from: "2026-08-28", count: 2 });
    expect(dates).toEqual(["2026-08-28", "2026-09-04"]); // Sat 8/29 -> Fri 8/28; Sat 9/5 -> Fri 9/4
  });

  it("drops a weekend-adjusted occurrence that shifts to before the window's 'from'", () => {
    const rule: RecurrenceRule = { kind: "daily", interval: 7, weekendAdjustment: "nearest_weekday" };
    const dates = expandOccurrences(rule, "2026-08-29", { from: "2026-08-29", count: 2 });
    expect(dates).toEqual(["2026-09-04", "2026-09-11"]);
  });

  it("computes a single 'days before' occurrence relative to an already-resolved external anchor date, regardless of 'from'", () => {
    const rule: RecurrenceRule = {
      kind: "days_before",
      days: 3,
      anchorEntity: { type: "calendar_event", id: "evt_test" },
    };
    // anchorDate here stands in for the *external* event's resolved date, per this function's own contract.
    // `from` is deliberately the anchor date itself (the natural, obvious value a caller would pass) to
    // prove the "backward from anchor" computation isn't wrongly filtered out by it — see this function's
    // own doc comment on the "days_before" case.
    const dates = expandOccurrences(rule, "2026-09-15", { from: "2026-09-15", count: 1 });
    expect(dates).toEqual(["2026-09-12"]);
  });

  it("respects a 'to' upper bound", () => {
    const rule: RecurrenceRule = { kind: "daily", interval: 1 };
    const dates = expandOccurrences(rule, "2026-09-01", { from: "2026-09-01", to: "2026-09-03" });
    expect(dates).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"]);
  });

  it("never returns an occurrence before the window's 'from'", () => {
    const rule: RecurrenceRule = { kind: "daily", interval: 1 };
    const dates = expandOccurrences(rule, "2026-09-01", { from: "2026-09-05", count: 2 });
    expect(dates).toEqual(["2026-09-05", "2026-09-06"]);
  });

  it("rejects 'mileage' rules — they have no calendar-date expansion", () => {
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: "veh_1", baselineMileage: 0 };
    expect(() => expandOccurrences(rule, "2026-09-01", { from: "2026-09-01", count: 1 })).toThrow();
  });

  it("rejects 'mileage_or_calendar' rules — same reasoning as 'mileage' above", () => {
    const rule: RecurrenceRule = { kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 3000, vehicleProfileId: "veh_1", baselineMileage: 0 };
    expect(() => expandOccurrences(rule, "2026-09-01", { from: "2026-09-01", count: 1 })).toThrow();
  });
});

describe("nextMileageDue", () => {
  const rule: RecurrenceRule & { kind: "mileage" } = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: "veh_1", baselineMileage: null };

  it("is not due with no odometer reading yet", () => {
    const status = nextMileageDue(rule, 0, null);
    expect(status).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: null, milesRemaining: null, isDue: false });
  });

  it("counts down remaining miles from the baseline", () => {
    const status = nextMileageDue(rule, 0, 3000);
    expect(status).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: 3000, milesRemaining: 2000, isDue: false });
  });

  it("is due exactly at the interval boundary", () => {
    const status = nextMileageDue(rule, 0, 5000);
    expect(status.isDue).toBe(true);
    expect(status.milesRemaining).toBe(0);
  });

  it("stays due (not silently rolling forward) once the vehicle has driven well past the due point", () => {
    // The due point only moves once the item is actually completed (ScheduleService re-anchors the
    // baseline then) — driving further past it without servicing it makes it more overdue, not "not due
    // yet for the next cycle."
    const status = nextMileageDue(rule, 0, 8000);
    expect(status.dueAtMileage).toBe(5000);
    expect(status.isDue).toBe(true);
    expect(status.milesRemaining).toBe(0);
  });

  it("counts forward from a non-zero baseline (e.g. re-anchored after a completed service)", () => {
    const status = nextMileageDue(rule, 42000, 44500);
    expect(status.dueAtMileage).toBe(47000);
    expect(status.milesRemaining).toBe(2500);
    expect(status.isDue).toBe(false);
  });
});

/**
 * VEH-003 "mileage_or_calendar" — the "3 months OR 3,000 miles, whichever comes first" composite rule
 * kind. `nextMileageOrCalendarCalendarDate` is exercised on its own first (the piece
 * ScheduleService.completeTask calls directly to advance the stored due date), then
 * `nextMileageOrCalendarDue`'s combined isDue logic.
 */
describe("nextMileageOrCalendarCalendarDate", () => {
  it("advances the anchor date by intervalMonths", () => {
    const rule: RecurrenceRule & { kind: "mileage_or_calendar" } = { kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 3000, vehicleProfileId: "veh_1", baselineMileage: null };
    expect(nextMileageOrCalendarCalendarDate(rule, "2026-06-15")).toBe("2026-09-15");
  });

  it("clamps to the target month's actual length, same as a plain monthly rule", () => {
    const rule: RecurrenceRule & { kind: "mileage_or_calendar" } = { kind: "mileage_or_calendar", intervalMonths: 1, intervalMiles: 3000, vehicleProfileId: "veh_1", baselineMileage: null };
    expect(nextMileageOrCalendarCalendarDate(rule, "2026-01-31")).toBe("2026-02-28");
  });
});

describe("nextMileageOrCalendarDue", () => {
  const rule: RecurrenceRule & { kind: "mileage_or_calendar" } = { kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 3000, vehicleProfileId: "veh_1", baselineMileage: null };

  it("is not due when neither side has reached its threshold", () => {
    const status = nextMileageOrCalendarDue(rule, "2026-06-01", 0, 1500, "2026-07-01");
    expect(status.calendarDueDate).toBe("2026-09-01");
    expect(status.mileage.isDue).toBe(false);
    expect(status.isDue).toBe(false);
  });

  it("is due once the calendar side alone reaches its date, even with mileage far from due", () => {
    const status = nextMileageOrCalendarDue(rule, "2026-06-01", 0, 100, "2026-09-02");
    expect(status.mileage.isDue).toBe(false);
    expect(status.isDue).toBe(true); // calendarDueDate (2026-09-01) <= today (2026-09-02)
  });

  it("is due once the mileage side alone reaches its threshold, even with the calendar date far off", () => {
    const status = nextMileageOrCalendarDue(rule, "2026-06-01", 0, 3200, "2026-06-15");
    expect(status.calendarDueDate).toBe("2026-09-01");
    expect(status.isDue).toBe(true); // mileage.isDue is true even though today is nowhere near calendarDueDate
  });

  it("is due when both sides have independently reached their threshold", () => {
    const status = nextMileageOrCalendarDue(rule, "2026-06-01", 0, 5000, "2026-10-01");
    expect(status.mileage.isDue).toBe(true);
    expect(status.isDue).toBe(true);
  });
});
