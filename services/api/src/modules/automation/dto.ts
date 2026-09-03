import { z } from "zod";

export const CreateRuleFromTextDtoSchema = z.object({
  householdId: z.string().nullable().optional(),
  naturalLanguageSource: z.string().min(3).max(500),
});
export type CreateRuleFromTextDto = z.infer<typeof CreateRuleFromTextDtoSchema>;

export const UpdateRuleDtoSchema = z.object({
  enabled: z.boolean().optional(),
  approvalMode: z.enum(["confirm_each_time", "auto_low_risk"]).optional(),
});
export type UpdateRuleDto = z.infer<typeof UpdateRuleDtoSchema>;
