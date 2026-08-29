import { z } from "zod";

export const ImportantDateDtoSchema = z.object({
  label: z.string().min(1).max(100),
  dateIso: z.string().min(1),
});
export type ImportantDateDto = z.infer<typeof ImportantDateDtoSchema>;

export const CreatePersonDtoSchema = z.object({
  displayLabel: z.string().min(1).max(200),
  relationshipLabel: z.string().max(100).nullable().optional(),
  importantDates: z.array(ImportantDateDtoSchema).max(20).optional(),
});
export type CreatePersonDto = z.infer<typeof CreatePersonDtoSchema>;

export const UpdatePersonDtoSchema = z.object({
  displayLabel: z.string().min(1).max(200).optional(),
  relationshipLabel: z.string().max(100).nullable().optional(),
  importantDates: z.array(ImportantDateDtoSchema).optional(),
});
export type UpdatePersonDto = z.infer<typeof UpdatePersonDtoSchema>;
