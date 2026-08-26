import { z } from "zod";

/**
 * §34.1 — automation risk tiers. Higher tiers require stronger confirmation;
 * L4 may remain unsupported until dedicated safeguards exist. This enum is
 * the single chokepoint every automation action must be classified against.
 */
export const AutomationRiskTierSchema = z.enum([
  "l0_organize", // tag/classify/archive — reversible, auto-run
  "l1_personal_action", // internal reminder/note — logged, undoable
  "l2_external_low_risk", // calendar write, external task/file — needs rule or confirmation
  "l3_consequential", // send message, cancel subscription, place order — confirm before execution
  "l4_high_risk", // money movement, legal signature, identity/security actions — strong reauth, some out of scope
]);
export type AutomationRiskTier = z.infer<typeof AutomationRiskTierSchema>;

export const AutomationApprovalModeSchema = z.enum(["auto", "confirm_each_time", "narrow_autopilot"]);
export type AutomationApprovalMode = z.infer<typeof AutomationApprovalModeSchema>;

export const AutomationRuleSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  name: z.string(),
  naturalLanguageSource: z.string().nullable(),
  triggerDescriptor: z.string(), // structured trigger (event type + condition)
  actionDescriptor: z.string(),
  riskTier: AutomationRiskTierSchema,
  approvalMode: AutomationApprovalModeSchema,
  enabled: z.boolean().default(true),
  version: z.number().int().default(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutomationRule = z.infer<typeof AutomationRuleSchema>;

export const AutomationRunStateSchema = z.enum([
  "triggered",
  "evaluating",
  "skipped",
  "approval_required",
  "authorized",
  "executing",
  "succeeded",
  "partially_succeeded",
  "failed",
  "rolled_back",
  "canceled",
]);
export type AutomationRunState = z.infer<typeof AutomationRunStateSchema>;

export const AutomationRunSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  triggerEvidenceId: z.string().nullable(),
  state: AutomationRunStateSchema,
  idempotencyKey: z.string(),
  commandsJson: z.unknown(),
  resultJson: z.unknown().nullable(),
  approvedByUserId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type AutomationRun = z.infer<typeof AutomationRunSchema>;
