import { z } from "zod";

export const CreateTaskDtoSchema = z.object({
  title: z.string().min(1).max(300),
  dueDateIso: z.string().min(1).nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  consequence: z.string().max(500).nullable().optional(),
  recurrenceRule: z.string().max(200).nullable().optional(),
});
export type CreateTaskDto = z.infer<typeof CreateTaskDtoSchema>;

export const UpdateTaskDtoSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  dueDateIso: z.string().min(1).nullable().optional(),
  priority: z.enum(["low", "medium", "high"]).optional(),
  consequence: z.string().max(500).nullable().optional(),
  recurrenceRule: z.string().max(200).nullable().optional(),
});
export type UpdateTaskDto = z.infer<typeof UpdateTaskDtoSchema>;

// CAL-002 — both optional: omitted destinationProvider keeps the existing Google-first default when more
// than one calendar is connected; omitted/null reminderMinutesBefore defers to the destination calendar's
// own default reminders rather than forcing one. `z.preprocess` normalizes a genuinely bodyless request
// (Fastify gives `undefined`, not `{}`, when no body/JSON content-type is sent) to an empty object first,
// so this route stays callable with no payload at all, matching its pre-existing behavior.
export const PushEventToCalendarDtoSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    destinationProvider: z.enum(["google_calendar", "microsoft_calendar"]).optional(),
    reminderMinutesBefore: z.number().int().min(0).max(40320).nullable().optional(), // 40320min = 28 days, Google Calendar's own max
  }),
);
export type PushEventToCalendarDto = z.infer<typeof PushEventToCalendarDtoSchema>;

// TASK-002 — same z.preprocess shape as PushEventToCalendarDtoSchema, for the same reason: a bodyless POST
// gives Fastify `undefined`, not `{}`, so this normalizes it to an empty object before validation.
export const PushTaskDtoSchema = z.preprocess(
  (value) => value ?? {},
  z.object({
    destinationProvider: z.enum(["google_tasks", "microsoft_todo"]).optional(),
  }),
);
export type PushTaskDto = z.infer<typeof PushTaskDtoSchema>;
