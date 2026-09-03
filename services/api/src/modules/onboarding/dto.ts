import { z } from "zod";

export const OnboardingGoalSchema = z.enum([
  "important_dates",
  "purchases_returns",
  "bills_subscriptions",
  "family",
  "travel",
  "things_i_own",
]);
export type OnboardingGoal = z.infer<typeof OnboardingGoalSchema>;

export const SetGoalDtoSchema = z.object({ goal: OnboardingGoalSchema });
export type SetGoalDto = z.infer<typeof SetGoalDtoSchema>;

export const OnboardingHistoryDepthChoiceSchema = z.enum(["forward_only", "days_30", "days_90", "months_6", "year_1", "build_history"]);
export type OnboardingHistoryDepthChoice = z.infer<typeof OnboardingHistoryDepthChoiceSchema>;

export const SetHistoryDepthDtoSchema = z.object({ choice: OnboardingHistoryDepthChoiceSchema });
export type SetHistoryDepthDto = z.infer<typeof SetHistoryDepthDtoSchema>;

export const OnboardingStepSchema = z.enum([
  "goal_selection",
  "pre_permission",
  "connecting",
  "historical_depth",
  "scanning",
  "discovery_review",
  "household_invite",
  "completed",
]);
export type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

export const AdvanceStepDtoSchema = z.object({ step: OnboardingStepSchema });
export type AdvanceStepDto = z.infer<typeof AdvanceStepDtoSchema>;

export const ScanStartDtoSchema = z.object({ connectionId: z.string().min(1) });
export type ScanStartDto = z.infer<typeof ScanStartDtoSchema>;

export const HouseholdInviteOfferedDtoSchema = z.object({ offered: z.boolean() });
export type HouseholdInviteOfferedDto = z.infer<typeof HouseholdInviteOfferedDtoSchema>;

export const ConnectorRecommendationSchema = z.enum(["gmail", "outlook", "plaid", "household", "manual_asset"]);
export type ConnectorRecommendation = z.infer<typeof ConnectorRecommendationSchema>;

export const ConsentPreviewQuerySchema = z.object({ connector: z.enum(["gmail", "outlook", "plaid"]) });
export type ConsentPreviewQuery = z.infer<typeof ConsentPreviewQuerySchema>;
