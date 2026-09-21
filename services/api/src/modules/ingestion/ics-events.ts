import * as ical from "node-ical";
import type { TemporalValue } from "@veynlo/core";

/**
 * Reading calendar events out of iCalendar text, in one place.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this is its own module
 * ---------------------------------------------------------------------------------------------------
 * The VEVENT-to-TemporalValue mapping existed twice, in `IcsAdapter.sync` and `CalDavAdapter.sync`, and
 * the two copies had already drifted:
 *
 *   CalDAV skipped a component with no `start`. ICS did not, and then called `component.start.toISOString()`
 *   on it — so one malformed VEVENT in a subscribed feed would throw and cost the whole sync every other
 *   event in that calendar. A VEVENT without DTSTART is invalid but perfectly possible to receive, and
 *   this connector polls addresses the user supplies.
 *
 *   ICS read the summary through a `textValue` helper that copes with node-ical returning an object;
 *   CalDAV used a bare `typeof === "string"` and filed "Untitled event" in exactly the cases the helper
 *   exists for.
 *
 * Two copies of one rule is how the provider-label map ended up wrong in six places at once. Now there is
 * one, and a third caller — an `.ics` file attached to an email — reuses it rather than adding a fourth.
 *
 * ---------------------------------------------------------------------------------------------------
 * What is deliberately not done here
 * ---------------------------------------------------------------------------------------------------
 * Recurrence is not expanded. node-ical reports RRULE, and turning "every Tuesday until December" into
 * individual events is a decision about how far ahead to materialise and what to do when the rule later
 * changes — not something to settle as a side effect of reading an attachment. A recurring event is read
 * as its first occurrence, which is what the feed connectors already did.
 */

export interface IcsEvent {
  /** The VEVENT's own UID, which is what de-duplicates it across re-fetches. */
  uid: string;
  title: string;
  start: TemporalValue;
  end: TemporalValue | null;
  isAllDay: boolean;
  location: string | null;
  /** "CANCELLED" for a cancellation notice, "TENTATIVE", "CONFIRMED", or null when unstated. */
  status: string | null;
}

/**
 * node-ical returns a string for most text properties, but an object with a `val` for a parameterised one
 * (`SUMMARY;LANGUAGE=en:Dentist`). Reading only the string case files those as "Untitled event".
 */
function textValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value === "object" && "val" in value) {
    const inner = (value as { val: unknown }).val;
    if (typeof inner === "string") return inner.trim() || null;
  }
  return null;
}

/** A node-ical date, which is a Date carrying an optional `tz`, as this app's temporal shape. */
function temporalFrom(value: Date & { tz?: string }, isAllDay: boolean): TemporalValue {
  return isAllDay
    ? { precision: "date", instantUtc: null, date: value.toISOString().slice(0, 10), timezone: null, sourceText: null }
    : { precision: "instant", instantUtc: value.toISOString(), date: null, timezone: value.tz ?? null, sourceText: null };
}

/** True for a value node-ical handed back as a usable date rather than something it could not parse. */
function isUsableDate(value: unknown): value is Date & { tz?: string } {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

/**
 * Every event in a parsed iCalendar object.
 *
 * Never throws for a malformed component: one bad VEVENT is skipped and the rest of the calendar is still
 * read. That is the behaviour CalDAV already had and ICS did not.
 */
export function calendarEventsFrom(calendar: ical.CalendarResponse, limit = Number.POSITIVE_INFINITY): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const component of Object.values(calendar)) {
    if (events.length >= limit) break;
    if (!component || component.type !== "VEVENT") continue;

    // A VEVENT with no start is not an event anybody can put on a calendar, and reading it was a crash
    // rather than a skip in one of the two places this used to live.
    const rawStart = (component as { start?: unknown }).start;
    if (!isUsableDate(rawStart)) continue;

    const isAllDay = (component as { datetype?: string }).datetype === "date";
    const rawEnd = (component as { end?: unknown }).end;

    // The UID is what de-duplicates this event on a later re-fetch. Without one there is nothing to
    // de-duplicate ON, so a re-synced feed would file the same event again on every poll.
    const uid = textValue((component as { uid?: unknown }).uid);
    if (!uid) continue;

    events.push({
      uid,
      title: textValue((component as { summary?: unknown }).summary) ?? "Untitled event",
      start: temporalFrom(rawStart, isAllDay),
      end: isUsableDate(rawEnd) ? temporalFrom(rawEnd, isAllDay) : null,
      isAllDay,
      location: textValue((component as { location?: unknown }).location),
      status: textValue((component as { status?: unknown }).status)?.toUpperCase() ?? null,
    });
  }
  return events;
}

/**
 * Every event in raw iCalendar text.
 *
 * Returns an empty array rather than throwing when the text is not a calendar at all — an email
 * attachment announcing itself as `text/calendar` and containing something else is a normal thing to
 * receive, and it must not cost the message its ingestion.
 */
export function calendarEventsFromText(text: string, limit = Number.POSITIVE_INFINITY): IcsEvent[] {
  if (!text || !text.includes("BEGIN:VEVENT")) return [];
  try {
    return calendarEventsFrom(ical.parseICS(text) as ical.CalendarResponse, limit);
  } catch {
    return [];
  }
}
