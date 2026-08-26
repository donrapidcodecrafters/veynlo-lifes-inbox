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
