import { z } from "zod";
import { RecurrenceRuleSchema } from "@veynlo/core";

// TASK-003 — the recurrence rule a task/event was created or edited with. Nullable-and-optional the same
// way every other originally-scalar field on these DTOs is: omitting it means "don't touch," an explicit
// `null` means "clear the recurrence."
const RecurrenceRuleField = RecurrenceRuleSchema.nullable().optional();

export const CreateTaskDtoSchema = z.object({
  title: z.string().min(1).max(300),
  dueIso: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  householdId: z.string().nullable().optional(),
  assignedToUserId: z.string().nullable().optional(),
  assignmentNotes: z.string().max(1000).nullable().optional(),
  recurrenceRule: RecurrenceRuleField,
});
export type CreateTaskDto = z.infer<typeof CreateTaskDtoSchema>;

export const AssignTaskDtoSchema = z.object({
  assignedToUserId: z.string().nullable(),
  assignmentNotes: z.string().max(1000).nullable().optional(),
});
export type AssignTaskDto = z.infer<typeof AssignTaskDtoSchema>;

export const SetTaskRecurrenceDtoSchema = z.object({ recurrenceRule: RecurrenceRuleSchema.nullable() });
export type SetTaskRecurrenceDto = z.infer<typeof SetTaskRecurrenceDtoSchema>;

/**
 * CAP-010-style manual add for calendar events — there was previously no user-facing way to create an
 * event at all (every existing row came from AI discovery or a provider sync), which TASK-003's "let the
 * user actually set a recurrence rule" requirement needs a creation path to hang off of. Deliberately
 * minimal, mirroring CreateTaskDtoSchema's own scope (see AddTaskForm in apps/web's Life page): no
 * multi-attendee/travel-time/reminder-customization fields, just enough to create a real event with an
 * optional recurrence.
 */
export const CreateEventDtoSchema = z.object({
  title: z.string().min(1).max(300),
  // A plain YYYY-MM-DD when isAllDay, otherwise a full ISO datetime. Kept as one field (like
  // CreateTaskDtoSchema's dueIso) rather than separate date/time inputs — the service derives the right
  // TemporalValue precision from isAllDay.
  startIso: z.string().min(1),
  endIso: z.string().nullable().optional(),
  isAllDay: z.boolean().optional().default(false),
  location: z.string().max(300).nullable().optional(),
  householdId: z.string().nullable().optional(),
  visibility: z.enum(["private", "household", "selected_people", "shared_link"]).optional(),
  recurrenceRule: RecurrenceRuleField,
  // CAL-002 "reminder defaults... let the user set/edit the reminder lead time... when creating a manual
  // event." Omitting it falls back to ScheduleService.createEvent's usual default (60/1440 minutes — see
  // ingestion/temporal.util.ts's defaultReminderMinutes); capped the same as AddToCalendarDtoSchema's
  // identical field.
  reminderMinutesBefore: z.number().int().min(0).max(4320).optional(),
  // CAL-003 "double-booked shared assets" — the vehicle (from `vehicleProfiles`) this event is "using," if
  // any. Populates `calendarEvents.relatedEntityIds` (ScheduleService.createEvent), the column
  // ConflictService.vehicleConflicts keys its double-booking check off of. Optional: most events don't
  // involve a vehicle at all.
  vehicleProfileId: z.string().nullable().optional(),
});
export type CreateEventDto = z.infer<typeof CreateEventDtoSchema>;

export const SetEventRecurrenceDtoSchema = z.object({ recurrenceRule: RecurrenceRuleSchema.nullable() });
export type SetEventRecurrenceDto = z.infer<typeof SetEventRecurrenceDtoSchema>;

/** CAL-002 — lets the user edit an existing event's reminder lead time (both a discovered/confirmed event
 * and a manually created one), separate from SetEventRecurrenceDtoSchema since it's a much more common,
 * lower-stakes edit that doesn't need TASK-003's recurrence machinery involved. */
export const SetEventReminderDtoSchema = z.object({ reminderMinutesBefore: z.number().int().min(0).max(4320).nullable() });
export type SetEventReminderDto = z.infer<typeof SetEventReminderDtoSchema>;

/** CAL-003 "double-booked shared assets" — lets an existing event's vehicle tag be set/changed/cleared after
 * creation, mirroring SetEventReminderDtoSchema's narrow-endpoint style. `null` clears the tag. */
export const SetEventVehicleDtoSchema = z.object({ vehicleProfileId: z.string().nullable() });
export type SetEventVehicleDto = z.infer<typeof SetEventVehicleDtoSchema>;
