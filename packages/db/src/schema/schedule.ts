import { pgTable, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { visibilityEnum } from "./common";

export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    start: jsonb("start").$type<TemporalValue>().notNull(),
    startSort: timestamp("start_sort", { withTimezone: true }),
    end: jsonb("end").$type<TemporalValue>(),
    isAllDay: boolean("is_all_day").notNull().default(false),
    location: text("location"),
    source: text("source").notNull(),
    providerEventId: text("provider_event_id"),
    recurrenceRule: text("recurrence_rule"),
    status: text("status").notNull().default("confirmed"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    relatedEntityIds: jsonb("related_entity_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calendar_events_owner_start_idx").on(t.ownerUserId, t.startSort),
    index("calendar_events_provider_idx").on(t.providerEventId),
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
    title: text("title").notNull(),
    dueCondition: jsonb("due_condition").$type<TemporalValue>(),
    dueSort: timestamp("due_sort", { withTimezone: true }),
    consequence: text("consequence"),
    priority: text("priority").notNull().default("medium"),
    recurrenceRule: text("recurrence_rule"),
    state: text("state").notNull().default("open"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    relatedEntityIds: jsonb("related_entity_ids").$type<string[]>().notNull().default([]),
    externalSyncProvider: text("external_sync_provider"),
    externalSyncId: text("external_sync_id"),
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
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});
