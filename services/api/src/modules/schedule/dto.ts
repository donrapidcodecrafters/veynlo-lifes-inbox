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
