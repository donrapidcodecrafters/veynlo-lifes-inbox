import { pgTable, text, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue, RecurrenceRule } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { connections } from "./connectors";
import { visibilityEnum } from "./common";
import { encryptedText } from "./encrypted-type";
import { healthAppointments } from "./health";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    // Encrypted — read via raw SQL in TimelineService, which manually decrypts it after the query.
    title: encryptedText("title").notNull(),
    start: jsonb("start").$type<TemporalValue>().notNull(),
    startSort: timestamp("start_sort", { withTimezone: true }),
    end: jsonb("end").$type<TemporalValue>(),
    isAllDay: boolean("is_all_day").notNull().default(false),
    location: encryptedText("location"),
    source: text("source").notNull(),
    providerEventId: text("provider_event_id"), // sync dedup lookup key — see calendar_events_provider_idx
    // TASK-003 — structured recurrence rule (packages/core/src/util/recurrence.ts), not free text. Was a
    // plain `text()` column that was stored but never read/expanded anywhere; now jsonb like the other
    // structured columns on this table (relatedEntityIds below, start/end), actually consumed by
    // ScheduleService's occurrence expansion.
    recurrenceRule: jsonb("recurrence_rule").$type<RecurrenceRule>(),
    status: text("status").notNull().default("confirmed"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    relatedEntityIds: jsonb("related_entity_ids").$type<string[]>().notNull().default([]),
    // CAL-002 "reminder defaults" — null means "use the default for this event" (60 minutes for a timed
    // event, 1440/one day for an all-day one — see ingestion.service.ts/schedule.service.ts's shared
    // `defaultReminderMinutes`), rather than baking the default in at write time, so a later product change
    // to the default doesn't require a backfill. AttentionService.scanAndFileDeadlines is the actual reader.
    reminderMinutesBefore: integer("reminder_minutes_before"),
    // CAL-001 "write-back capability" — set only once this Veynlo-created/edited event has actually been
    // pushed to a connected, write-back-enabled provider calendar (CalendarWriteBackService.pushEvent).
    // `providerEventId` above doubles as the push target's event id once set (the same column
    // ingestFeedCalendarEvent's pull-side dedup already keys off of — a pushed-then-synced-back event
    // correctly matches as an update, not a duplicate). `writeBackConnectionId` records which connection
    // owns that id (a user can have more than one write-back-enabled calendar connected) and
    // `writeBackStatus` — null | "pushed" | "failed" — lets a provider-side failure be surfaced without
    // ever touching (or losing) the local event: see CalendarWriteBackService.pushEvent's doc comment.
    writeBackConnectionId: text("write_back_connection_id").references(() => connections.id, { onDelete: "set null" }),
    writeBackStatus: text("write_back_status"),
    // CAL-001 "duplicate copies visually collapse while preserving original records" — set on the SECOND
    // of two independently-discovered copies of the same real-world event (one from `ingestFeedCalendarEvent`
    // — a provider/device calendar sync, identified by a non-null `providerEventId` — the other from
    // `extractCalendarEvent` — an email-discovered event, `providerEventId` null; see
    // IngestionService.findCrossSourceCalendarEventMatch for the exact-title/±3h-window/no-ambiguous-match
    // precision discipline). Points at whichever of the pair was created first; that row's own
    // `linkedEventId` stays null, so "group leader" is always `linkedEventId ?? id`. Deliberately NOT a
    // merge: both rows keep their own independent data forever (spec's own "preserving original records"),
    // this column only records that they're believed to be the same real-world appointment, for the
    // display layer to visually collapse into one card. No `.references()` FK — same precedent as
    // `merchants.mergedIntoMerchantId` (commerce.ts) for a same-table lineage pointer that must survive the
    // pointed-at row being read back without a join-cycle in drizzle-kit's self-referencing-table codegen.
    linkedEventId: text("linked_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_events_owner_start_idx").on(t.ownerUserId, t.startSort),
    index("calendar_events_provider_idx").on(t.providerEventId),
    index("calendar_events_linked_event_idx").on(t.linkedEventId),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
    // FAM-003 "Assignment has acceptance/decline/complete" — "unassigned" whenever assignedToUserId is
    // null; set to "pending" on every new assignment, "accepted"/"declined" by the assignee's own action.
    // A declined assignment stays declined (and assignedToUserId stays set) rather than silently reverting
    // to unassigned, so the owner can see who declined it before deciding to reassign — matches the spec's
    // own "no one accepts assignment" edge case, which implies the owner needs visibility into a decline,
    // not silent auto-clearing.
    assignmentStatus: text("assignment_status").notNull().default("unassigned"),
    title: encryptedText("title").notNull(),
    dueCondition: jsonb("due_condition").$type<TemporalValue>(),
    dueSort: timestamp("due_sort", { withTimezone: true }),
    consequence: encryptedText("consequence"),
    assignmentNotes: encryptedText("assignment_notes"),
    priority: text("priority").notNull().default("medium"),
    // TASK-003 — see calendarEvents.recurrenceRule's identical comment above.
    recurrenceRule: jsonb("recurrence_rule").$type<RecurrenceRule>(),
    state: text("state").notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    relatedEntityIds: jsonb("related_entity_ids").$type<string[]>().notNull().default([]),
    // HLTH-001 "forms/tasks" linkage — mirrors bills.healthAppointmentId (commerce.ts) exactly: an owner
    // can attach an existing task ("bring insurance card," "fast for 8 hours before") to one health
    // appointment. Deliberately a dedicated FK column rather than reusing the generic relatedEntityIds
    // array above — that array already has an established, different meaning per row kind (e.g. a school
    // event id, a pet id — see ingestion.service.ts/school.service.ts), and a task can only ever prep for
    // one appointment at a time, same one-to-many shape bills already use.
    healthAppointmentId: text("health_appointment_id").references(() => healthAppointments.id, { onDelete: "set null" }),
    externalSyncProvider: text("external_sync_provider"),
    externalSyncId: text("external_sync_id"), // likely a future sync dedup lookup key, kept plaintext defensively
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tasks_owner_due_idx").on(t.ownerUserId, t.dueSort)],
);

export const scheduleConflicts = pgTable("schedule_conflicts", {
  id: text("id").primaryKey(),
  householdId: text("household_id").references(() => households.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  involvedEventIds: jsonb("involved_event_ids").$type<string[]>().notNull().default([]),
  // Adult-availability heuristic for "school_transport" conflicts (ConflictService.schoolTransportConflicts)
  // — "standard" (the pre-existing behavior: two dependents need a ride, availability unknown/unchecked) vs
  // "elevated" (checked against ScheduleService.householdAdultBusyIntervals and found that at least one of
  // the two drop-off/pickup windows has NO free adult household member at all — a real, more urgent problem
  // than "two kids need rides," not just that fact restated). Always "standard" for "time_overlap" conflicts,
  // which have no adult-availability concept. Never derived from anything more sensitive than busy/free
  // booleans — see householdAdultBusyIntervals' own doc comment on why title/detail never factors in here.
  severity: text("severity").notNull().default("standard"),
  // Which of involvedEventIds (a subset, school_transport only) had no free adult for its drop-off/pickup
  // window — lets the UI say specifically *which* child's ride has nobody available, without this table ever
  // storing anything about *who* (no userId, no adult identity) or *why* (no event title/detail) — only an
  // event id the caller already has independent, authorized access to resolve into a title client-side.
  unavailableEventIds: jsonb("unavailable_event_ids").$type<string[]>().notNull().default([]),
  // CAL-003 recurring-event conflict expansion — null for a conflict between two events' own stored
  // (non-recurring, or recurring-but-anchor-only) start times, exactly the pre-existing identity every
  // pre-recurrence-expansion conflict row already had. Set to the specific YYYY-MM-DD occurrence date when
  // the collision was only found by expanding a recurring event's future occurrences (ConflictService's
  // `occurrenceRanges`/bounded-window policy) — a weekly series colliding with the same other event on three
  // different future dates is three DIFFERENT real-world collisions, each needing its own row (and its own
  // independent resolve), not one row that silently also covers the other two dates. Combined with
  // `involvedEventIds` for dedup: re-detecting the SAME occurrence-date collision reuses this exact row
  // rather than creating a duplicate — the established dedup discipline, just keyed one level finer.
  occurrenceDate: text("occurrence_date"),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});
