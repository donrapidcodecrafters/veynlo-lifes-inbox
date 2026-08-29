import { z } from "zod";

export const SignUpDtoSchema = z.object({
  email: z.string().email(),
  password: z.string().min(10).max(200),
  displayName: z.string().min(1).max(120),
  timezone: z.string().default("UTC"),
});
export type SignUpDto = z.infer<typeof SignUpDtoSchema>;

export const SignInDtoSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type SignInDto = z.infer<typeof SignInDtoSchema>;

export const DeleteAccountDtoSchema = z.object({
  password: z.string().min(1).max(200),
});
export type DeleteAccountDto = z.infer<typeof DeleteAccountDtoSchema>;

export const SetAiProcessingDtoSchema = z.object({
  enabled: z.boolean(),
});
export type SetAiProcessingDto = z.infer<typeof SetAiProcessingDtoSchema>;

export const RegisterPushTokenDtoSchema = z.object({
  pushToken: z.string().min(1).max(400),
});
export type RegisterPushTokenDto = z.infer<typeof RegisterPushTokenDtoSchema>;
