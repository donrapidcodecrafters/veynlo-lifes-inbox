import { z } from "zod";
import { TemporalValueSchema } from "../util/time";
import { RecurrenceRuleSchema } from "../util/recurrence";
import { ProvenanceSchema } from "./provenance";
import { VisibilitySchema } from "../permissions/sensitivity";

export const CalendarEventSourceSchema = z.enum([
  "google_calendar",
  "microsoft_calendar",
  "apple_local_calendar",
  "caldav",
  "ics_feed",
  "discovered_from_evidence",
  "manual",
]);
export type CalendarEventSource = z.infer<typeof CalendarEventSourceSchema>;

export const CalendarEventSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  title: z.string(),
  start: TemporalValueSchema,
  end: TemporalValueSchema.nullable(),
  isAllDay: z.boolean().default(false),
  location: z.string().nullable(),
  source: CalendarEventSourceSchema,
  providerEventId: z.string().nullable(),
  // TASK-003 — was a free-text RRULE-ish string nobody ever wrote or read; now a real structured rule
  // (packages/core/src/util/recurrence.ts) that ScheduleService actually expands.
  recurrenceRule: RecurrenceRuleSchema.nullable(),
  status: z.enum(["confirmed", "tentative", "canceled"]).default("confirmed"),
  visibility: VisibilitySchema,
  relatedEntityIds: z.array(z.string()).default([]),
  provenance: ProvenanceSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

export const TaskStateSchema = z.enum(["open", "snoozed", "completed", "dismissed"]);
export type TaskState = z.infer<typeof TaskStateSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  assignedToUserId: z.string().nullable(),
  title: z.string(),
  dueCondition: TemporalValueSchema.nullable(),
  consequence: z.string().nullable(), // plain-language "why this matters"
  priority: z.enum(["low", "medium", "high"]).default("medium"),
  recurrenceRule: RecurrenceRuleSchema.nullable(),
  state: TaskStateSchema,
  snoozedUntil: z.string().datetime().nullable(),
  relatedEntityIds: z.array(z.string()).default([]),
  externalSyncProvider: z.string().nullable(), // e.g. "apple_reminders", "google_tasks"
  externalSyncId: z.string().nullable(),
  provenance: ProvenanceSchema.nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Task = z.infer<typeof TaskSchema>;

export const ScheduleConflictSchema = z.object({
  id: z.string(),
  householdId: z.string().nullable(),
  kind: z.enum(["time_overlap", "impossible_travel", "double_booked_resource", "source_date_mismatch"]),
  involvedEventIds: z.array(z.string()),
  detectedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().nullable(),
});
export type ScheduleConflict = z.infer<typeof ScheduleConflictSchema>;
