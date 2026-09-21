import { describe, expect, it } from "vitest";
import { calendarEventsFromText } from "./ics-events";

/**
 * Reading calendar events out of iCalendar text.
 *
 * This mapping used to exist twice — in `IcsAdapter.sync` and `CalDavAdapter.sync` — and the two copies had
 * already drifted apart. The tests below pin the union of what each did correctly, because the merged
 * version has to be at least as good as the better of the two on every point where they disagreed.
 */

const ics = (body: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Test//EN\r\n${body}\r\nEND:VCALENDAR\r\n`;

const event = (extra: string) => ics(`BEGIN:VEVENT\r\nUID:evt-1@example.test\r\n${extra}\r\nEND:VEVENT`);

describe("a timed event", () => {
  it("is read as an instant, with its title and location", () => {
    const events = calendarEventsFromText(
      event("SUMMARY:Dentist\r\nLOCATION:12 High St\r\nDTSTART:20260415T143000Z\r\nDTEND:20260415T150000Z"),
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.uid).toBe("evt-1@example.test");
    expect(e.title).toBe("Dentist");
    expect(e.location).toBe("12 High St");
    expect(e.isAllDay).toBe(false);
    expect(e.start.precision).toBe("instant");
    expect(e.start.instantUtc).toBe("2026-04-15T14:30:00.000Z");
    expect(e.end?.instantUtc).toBe("2026-04-15T15:00:00.000Z");
  });

  it("is read as a date when it is all day", () => {
    const events = calendarEventsFromText(event("SUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20260415\r\nDTEND;VALUE=DATE:20260416"));
    expect(events[0]?.isAllDay).toBe(true);
    expect(events[0]?.start.precision).toBe("date");
    expect(events[0]?.start.date).toBe("2026-04-15");
  });

  it("survives having no DTEND", () => {
    // node-ical fills `end` from `start` when DTEND is absent, so the event comes back zero-length rather
    // than end-less. That is what both of the old copies already produced, and extracting the mapping was
    // not the moment to change it — pinned here so the behaviour is stated rather than assumed by the next
    // person who reads it.
    const events = calendarEventsFromText(event("SUMMARY:Reminder\r\nDTSTART:20260415T143000Z"));
    expect(events[0]?.start.instantUtc).toBe("2026-04-15T14:30:00.000Z");
    expect(events[0]?.end?.instantUtc).toBe("2026-04-15T14:30:00.000Z");
  });
});

describe("the two things the old copies disagreed about", () => {
  it("skips a VEVENT whose DTSTART could not be parsed", () => {
    // Measured against node-ical: for `DTSTART:NOTADATE` it hands back the raw STRING, not a Date. So a
    // guard written as `if (!start) continue` lets it through — a non-empty string is truthy — and the next
    // line calls `.toISOString()` on a string. That is why the check is `instanceof Date` rather than a
    // truthiness test, and why the DTSTART-less fixture below could not prove it: that one is skipped by
    // either guard.
    const both = ics(
      "BEGIN:VEVENT\r\nUID:garbage@example.test\r\nSUMMARY:Bad date\r\nDTSTART:NOTADATE\r\nEND:VEVENT\r\n" +
        "BEGIN:VEVENT\r\nUID:good2@example.test\r\nSUMMARY:Fine\r\nDTSTART:20260415T143000Z\r\nEND:VEVENT",
    );
    expect(calendarEventsFromText(both).map((e) => e.uid)).toEqual(["good2@example.test"]);
  });

  it("skips a VEVENT with no start at all instead of throwing on it", () => {
    // CalDAV guarded this. ICS did not, and then called `component.start.toISOString()` on undefined — so
    // one malformed VEVENT in a subscribed feed cost the whole sync every OTHER event in that calendar.
    // The good event in the same calendar is the point of this test.
    const both = ics(
      "BEGIN:VEVENT\r\nUID:broken@example.test\r\nSUMMARY:No start\r\nEND:VEVENT\r\n" +
        "BEGIN:VEVENT\r\nUID:good@example.test\r\nSUMMARY:Fine\r\nDTSTART:20260415T143000Z\r\nEND:VEVENT",
    );
    const events = calendarEventsFromText(both);
    expect(events.map((e) => e.uid)).toEqual(["good@example.test"]);
  });

  it("reads a summary that carries a parameter", () => {
    // node-ical returns an object with a `val` for `SUMMARY;LANGUAGE=en:...`. ICS coped via a helper;
    // CalDAV's bare `typeof === "string"` filed these as "Untitled event" — the exact case the helper
    // existed for.
    const events = calendarEventsFromText(event("SUMMARY;LANGUAGE=en:Parents evening\r\nDTSTART:20260415T143000Z"));
    expect(events[0]?.title).toBe("Parents evening");
  });
});

describe("what is refused", () => {
  it("skips a VEVENT with no UID, because nothing could de-duplicate it later", () => {
    // Without a UID a re-synced feed files the same event again on every poll.
    const noUid = ics("BEGIN:VEVENT\r\nSUMMARY:Anonymous\r\nDTSTART:20260415T143000Z\r\nEND:VEVENT");
    expect(calendarEventsFromText(noUid)).toHaveLength(0);
  });

  it("returns nothing for text that is not a calendar, rather than throwing", () => {
    // An attachment announcing itself as text/calendar and containing something else is a normal thing to
    // receive, and it must not cost the message its ingestion.
    expect(calendarEventsFromText("just some text")).toEqual([]);
    expect(calendarEventsFromText("")).toEqual([]);
    expect(calendarEventsFromText("BEGIN:VCALENDAR\r\nthis is truncat")).toEqual([]);
  });

  it("ignores a VTODO or VJOURNAL in the same calendar", () => {
    // The VTODO carries a DTSTART on purpose. With only a DUE it is skipped by the missing-start guard
    // whether the type is checked or not, so the version of this test that used DUE proved nothing about
    // the type check it is named after — falsification found it by deleting that check and staying green.
    const mixed = ics(
      "BEGIN:VTODO\r\nUID:todo@example.test\r\nSUMMARY:A task\r\nDTSTART:20260415T143000Z\r\nEND:VTODO\r\n" +
        "BEGIN:VEVENT\r\nUID:evt@example.test\r\nSUMMARY:An event\r\nDTSTART:20260415T143000Z\r\nEND:VEVENT",
    );
    expect(calendarEventsFromText(mixed).map((e) => e.uid)).toEqual(["evt@example.test"]);
  });

  it("bounds how many events one calendar can contribute", () => {
    const many = ics(
      Array.from({ length: 50 }, (_, i) => `BEGIN:VEVENT\r\nUID:e-${i}@example.test\r\nSUMMARY:E${i}\r\nDTSTART:20260415T143000Z\r\nEND:VEVENT`).join("\r\n"),
    );
    expect(calendarEventsFromText(many, 10)).toHaveLength(10);
  });
});

describe("a cancellation", () => {
  it("is reported as one rather than read as an ordinary event", () => {
    // A meeting invite that is a CANCEL carries STATUS:CANCELLED. Filing it as a normal event would put a
    // meeting on somebody's calendar that the organiser had just called off.
    const cancelled = event("SUMMARY:Standup\r\nDTSTART:20260415T143000Z\r\nSTATUS:CANCELLED");
    expect(calendarEventsFromText(cancelled)[0]?.status).toBe("CANCELLED");
  });

  it("leaves the status null when the calendar states none", () => {
    expect(calendarEventsFromText(event("SUMMARY:Standup\r\nDTSTART:20260415T143000Z"))[0]?.status).toBeNull();
  });
});
