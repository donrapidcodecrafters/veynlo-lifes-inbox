import { z } from "zod";

export const CreateHouseholdDtoSchema = z.object({
  name: z.string().min(1).max(120),
});
export type CreateHouseholdDto = z.infer<typeof CreateHouseholdDtoSchema>;

export const InviteMemberDtoSchema = z.object({
  email: z.string().email(),
  relationshipLabel: z.string().max(60).nullable().optional(),
});
export type InviteMemberDto = z.infer<typeof InviteMemberDtoSchema>;

export const CreateDependentDtoSchema = z.object({
  displayName: z.string().min(1).max(120),
  birthDate: z.string().nullable().optional(),
});
export type CreateDependentDto = z.infer<typeof CreateDependentDtoSchema>;
