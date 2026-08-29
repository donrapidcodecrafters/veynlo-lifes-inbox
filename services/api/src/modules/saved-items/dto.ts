import { z } from "zod";

export const CreateSavedItemDtoSchema = z.object({
  title: z.string().min(1).max(500),
  url: z.string().url().max(2000).optional(),
  note: z.string().max(10_000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
});
export type CreateSavedItemDto = z.infer<typeof CreateSavedItemDtoSchema>;

export const UpdateSavedItemDtoSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  note: z.string().max(10_000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  pinned: z.boolean().optional(),
  archived: z.boolean().optional(),
});
export type UpdateSavedItemDto = z.infer<typeof UpdateSavedItemDtoSchema>;
