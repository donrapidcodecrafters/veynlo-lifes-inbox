import { pgTable, text, timestamp, boolean, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { calendarEvents } from "./schedule";
import { inboxItems } from "./attention";
import { encryptedText } from "./encrypted-type";

/**
 * CAL-004 "Offer update or auto-update only when user has an explicit trusted rule" — the trusted-rule
 * concept the spec calls for, and this codebase previously had none of at all (grepped: zero calendar-
 * reschedule trigger/action kind anywhere, including in `automation_rules`). Deliberately its own small
 * table rather than reusing `automation_rules`: that table's trigger/action vocabulary (rule-schemas.ts)
 * is a natural-language-parsed automation engine (notify/add_task/add_calendar_event actions keyed on
 * purchase/bill/appointment triggers) — a boolean "do I trust reschedule emails from this sender" toggle
 * doesn't fit that shape (no matching trigger kind, no action to parse) and inventing one would be a worse
 * fit than a dedicated table.
 *
 * Scoped per-sender-domain, not per-source-connection: a discovered/rescheduled calendar event
 * (`IngestionService.extractCalendarEvent`) never carries a connectionId of its own — only provider-synced
 * events do (`ingestFeedCalendarEvent`), and those are explicitly out of CAL-004's reschedule-reconciliation
 * scope (see `findExistingDiscoveredCalendarEvent`'s own doc comment: they're already deduped by
 * `providerEventId`). The sender's email domain is the one scoping key actually available at the point a
 * reschedule-reconciliation decision is made (the parsed email's `fromAddress`), so that's what this keys
 * on. Off by default: no row for a given (ownerUserId, senderDomain) pair means "not trusted," full stop —
 * `IngestionService.extractCalendarEvent` never auto-applies a reschedule match without one.
 */
export const calendarRescheduleTrustedRules = pgTable(
  "calendar_reschedule_trusted_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderDomain: text("sender_domain").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_reschedule_trusted_rules_owner_domain_idx").on(t.ownerUserId, t.senderDomain)],
);

/**
 * CAL-004 "offer, don't auto-apply" — when `IngestionService.extractCalendarEvent` finds a match against
 * an existing discovered event but no trusted rule (above) applies for the sending domain, the proposed
 * date/time/location change is filed here instead of being written straight onto the `calendar_events`
 * row, so the inbox item's "apply_change"/"dismiss" actions have something concrete to apply or discard.
 * One row per offered inbox item — `InboxService.applyRescheduleChange` reads it, writes the fields onto
 * the linked calendar event (and re-runs CAL-003 conflict detection, since the event's time is actually
 * changing at that point), then leaves the row in place as a record of what was offered — mirroring this
 * codebase's "review actions are soft-state, not destructive" stance (`InboxService.dismiss`/`archive`
 * never hard-delete either).
 */
export const calendarRescheduleProposals = pgTable("calendar_reschedule_proposals", {
  id: text("id").primaryKey(),
  inboxItemId: text("inbox_item_id")
    .notNull()
    .references(() => inboxItems.id, { onDelete: "cascade" }),
  calendarEventId: text("calendar_event_id")
    .notNull()
    .references(() => calendarEvents.id, { onDelete: "cascade" }),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Null when the source email had no parseable sender domain (e.g. a manually-entered reschedule note) —
  // "trust this sender" is simply unavailable as a follow-up action in that case, but the change can still
  // be reviewed/applied.
  senderDomain: text("sender_domain"),
  proposedStart: jsonb("proposed_start").$type<TemporalValue>().notNull(),
  proposedIsAllDay: boolean("proposed_is_all_day").notNull().default(false),
  proposedLocation: encryptedText("proposed_location"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
