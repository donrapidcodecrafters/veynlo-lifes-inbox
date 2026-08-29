import { describe, expect, it } from "vitest";
import { parseRecurrenceRule, nextOccurrence } from "./recurrence.util";

describe("parseRecurrenceRule", () => {
  it("parses a bare FREQ with implicit interval 1", () => {
    expect(parseRecurrenceRule("FREQ=DAILY")).toEqual({ freq: "DAILY", interval: 1 });
  });

  it("parses FREQ with an explicit INTERVAL", () => {
    expect(parseRecurrenceRule("FREQ=WEEKLY;INTERVAL=2")).toEqual({ freq: "WEEKLY", interval: 2 });
  });

  it("supports MONTHLY and YEARLY", () => {
    expect(parseRecurrenceRule("FREQ=MONTHLY;INTERVAL=3")).toEqual({ freq: "MONTHLY", interval: 3 });
    expect(parseRecurrenceRule("FREQ=YEARLY")).toEqual({ freq: "YEARLY", interval: 1 });
  });

  it("returns null for an unsupported FREQ (e.g. a real RRULE's HOURLY/MINUTELY)", () => {
    expect(parseRecurrenceRule("FREQ=HOURLY")).toBeNull();
  });

  it("returns null for a malformed or empty rule instead of throwing", () => {
    expect(parseRecurrenceRule("")).toBeNull();
    expect(parseRecurrenceRule("not a rule")).toBeNull();
  });

  it("returns null for a non-positive-integer INTERVAL", () => {
    expect(parseRecurrenceRule("FREQ=DAILY;INTERVAL=0")).toBeNull();
    expect(parseRecurrenceRule("FREQ=DAILY;INTERVAL=-1")).toBeNull();
    expect(parseRecurrenceRule("FREQ=DAILY;INTERVAL=abc")).toBeNull();
  });
});

describe("nextOccurrence", () => {
  it("advances by whole days for DAILY", () => {
    const result = nextOccurrence(new Date("2026-01-01T12:00:00Z"), { freq: "DAILY", interval: 3 });
    expect(result.toISOString()).toBe("2026-01-04T12:00:00.000Z");
  });

  it("advances by whole weeks for WEEKLY", () => {
    const result = nextOccurrence(new Date("2026-01-01T12:00:00Z"), { freq: "WEEKLY", interval: 2 });
    expect(result.toISOString()).toBe("2026-01-15T12:00:00.000Z");
  });

  it("advances by months for MONTHLY, correctly rolling over year boundaries", () => {
    const result = nextOccurrence(new Date("2026-12-01T12:00:00Z"), { freq: "MONTHLY", interval: 2 });
    expect(result.toISOString()).toBe("2027-02-01T12:00:00.000Z");
  });

  it("advances by years for YEARLY", () => {
    const result = nextOccurrence(new Date("2026-01-01T12:00:00Z"), { freq: "YEARLY", interval: 1 });
    expect(result.toISOString()).toBe("2027-01-01T12:00:00.000Z");
  });
});
