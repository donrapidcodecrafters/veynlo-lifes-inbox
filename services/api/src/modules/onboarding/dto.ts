import { z } from "zod";

export const ONBOARDING_GOALS = [
  "important_dates",
  "purchases_returns",
  "bills_subscriptions",
  "family",
  "travel",
  "things_i_own",
] as const;
export type OnboardingGoal = (typeof ONBOARDING_GOALS)[number];

export const ONBOARDING_STEPS = ["goals", "connect", "scanning", "summary"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

export const UpdateOnboardingStateDtoSchema = z.object({
  goal: z.enum(ONBOARDING_GOALS).optional(),
  step: z.enum(ONBOARDING_STEPS).optional(),
});
export type UpdateOnboardingStateDto = z.infer<typeof UpdateOnboardingStateDtoSchema>;
