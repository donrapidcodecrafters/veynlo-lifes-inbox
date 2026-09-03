import { z } from "zod";
import { SmartListQuerySchema } from "../memories/dto";

export const LIST_KINDS = ["grocery", "packing", "household_maintenance", "gift", "school_supplies", "trip_prep", "custom"] as const;

/** §29.1 SAVE-003 "Smart lists... A smart list stores query criteria; manual lists store membership; both
 * can coexist." `smartListQuery` set at creation makes this a query-driven list (see ListsService.listDetail
 * / MemoriesService.evaluateSmartQuery) instead of a manual-membership one — mutually exclusive with ever
 * calling `POST /v1/lists/:id/items` on it in practice, though nothing at the DB level forbids both. */
export const CreateListDtoSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.enum(LIST_KINDS).optional(),
  householdId: z.string().nullable().optional(),
  smartListQuery: SmartListQuerySchema.optional(),
});
export type CreateListDto = z.infer<typeof CreateListDtoSchema>;

export const UpdateListDtoSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  archived: z.boolean().optional(),
  smartListQuery: SmartListQuerySchema.nullable().optional(),
});
export type UpdateListDto = z.infer<typeof UpdateListDtoSchema>;

export const CreateSavedItemDtoSchema = z.object({
  label: z.string().min(1).max(300),
  assignedToUserId: z.string().nullable().optional(),
  linkedResourceType: z.string().max(60).nullable().optional(),
  linkedResourceId: z.string().nullable().optional(),
  isPrivate: z.boolean().optional(),
});
export type CreateSavedItemDto = z.infer<typeof CreateSavedItemDtoSchema>;

export const UpdateSavedItemDtoSchema = z.object({
  label: z.string().min(1).max(300).optional(),
  checked: z.boolean().optional(),
  assignedToUserId: z.string().nullable().optional(),
  isPrivate: z.boolean().optional(),
});
export type UpdateSavedItemDto = z.infer<typeof UpdateSavedItemDtoSchema>;
