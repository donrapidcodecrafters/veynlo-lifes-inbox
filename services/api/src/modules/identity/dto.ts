import { z } from "zod";
import { NormalizedEmailSchema } from "../../common/normalized-email";

export const SignUpDtoSchema = z.object({
  email: NormalizedEmailSchema,
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  timezone: z.string().default("UTC"),
  // Required only when SIGNUP_REQUIRES_INVITE is on (checked in IdentityService.signUp, not here — this
  // DTO has no visibility into runtime config) — "Pre-launch private testing distribution" (docs/ROADMAP.md).
  inviteCode: z.string().min(1).max(64).optional(),
});
export type SignUpDto = z.infer<typeof SignUpDtoSchema>;

export const SignInDtoSchema = z.object({
  email: NormalizedEmailSchema,
  password: z.string().min(1).max(200),
});
export type SignInDto = z.infer<typeof SignInDtoSchema>;

export const RefreshSessionDtoSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshSessionDto = z.infer<typeof RefreshSessionDtoSchema>;

export const DeleteAccountDtoSchema = z.object({
  // Optional, not required — an OAuth-only account (no passwordHash) has no password to re-verify;
  // requestDeletion's step-up check (verifyStepUpPassword) is a no-op for exactly that case, same as
  // every other step-up-gated action (data export, connector disconnect). Requiring one here would have
  // permanently locked OAuth-only users out of self-service account deletion — a real bug found via live
  // audit, and a direct App Store §5.1.1(v) / Play Store compliance issue since in-app self-service
  // deletion is mandatory.
  password: z.string().min(1).max(200).optional(),
});
export type DeleteAccountDto = z.infer<typeof DeleteAccountDtoSchema>;

export const ForgotPasswordDtoSchema = z.object({
  email: NormalizedEmailSchema,
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordDtoSchema>;

export const ResetPasswordDtoSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(10).max(200),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordDtoSchema>;

export const SetAiProcessingDtoSchema = z.object({
  enabled: z.boolean(),
});
export type SetAiProcessingDto = z.infer<typeof SetAiProcessingDtoSchema>;

export const RegisterPushTokenDtoSchema = z.object({
  pushToken: z.string().min(1).max(400),
});
export type RegisterPushTokenDto = z.infer<typeof RegisterPushTokenDtoSchema>;
