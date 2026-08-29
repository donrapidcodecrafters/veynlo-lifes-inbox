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

/** MAIL-002 "category privacy controls" — restricted to categories IngestionService.classifyAndExtract
 * actually dispatches to an extractor (unlike the domain classifier's broader recognized set, which
 * includes a few — school/home/vehicle/saved_item/identity_document — nothing acts on yet). Exposing a
 * toggle for a category nothing enforces would be a UI that lies about what it does. */
export const MAIL_CATEGORIES = ["receipt", "shipment", "bill", "subscription", "calendar_event", "travel", "warranty"] as const;
export const SetDisabledMailCategoriesDtoSchema = z.object({
  categories: z.array(z.enum(MAIL_CATEGORIES)),
});
export type SetDisabledMailCategoriesDto = z.infer<typeof SetDisabledMailCategoriesDtoSchema>;

export const RegisterPushTokenDtoSchema = z.object({
  pushToken: z.string().min(1).max(400),
});
export type RegisterPushTokenDto = z.infer<typeof RegisterPushTokenDtoSchema>;
