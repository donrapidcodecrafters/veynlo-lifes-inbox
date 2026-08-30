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

export const ForgotPasswordDtoSchema = z.object({
  email: z.string().email(),
});
export type ForgotPasswordDto = z.infer<typeof ForgotPasswordDtoSchema>;

export const ResetPasswordDtoSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: z.string().min(10).max(200),
});
export type ResetPasswordDto = z.infer<typeof ResetPasswordDtoSchema>;

export const DeleteAccountDtoSchema = z.object({
  // Optional: an OAuth-only account (Google/Microsoft sign-in) has no password to confirm at all — its
  // already-verified session is the reauth for those accounts. See IdentityService.requestDeletion.
  password: z.string().min(1).max(200).optional(),
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

// CAP-005 "permitted-senders allowlist mode" — each entry is either a full address ("jane@example.com")
// or a domain, written "@example.com". An empty array (the default) means "accept from anyone" — this
// never makes the forwarding alias stricter than the existing DMARC check unless the user opts in.
export const SetPermittedInboundSendersDtoSchema = z.object({
  senders: z.array(z.string().trim().toLowerCase().min(3).max(254)).max(100),
});
export type SetPermittedInboundSendersDto = z.infer<typeof SetPermittedInboundSendersDtoSchema>;

// PRIV-001 "retention policy settings beyond Documents" — a large-but-finite bound (730 days) stands in
// for "keep as long as possible short of forever," same reasoning as connectors' 3650-day "All history"
// option; `null` means keep forever (the default, unchanged behavior for every existing user).
export const SetDataRetentionDaysDtoSchema = z.object({
  days: z.union([z.literal(90), z.literal(180), z.literal(365), z.literal(730), z.null()]),
});
export type SetDataRetentionDaysDto = z.infer<typeof SetDataRetentionDaysDtoSchema>;

export const RegisterPushTokenDtoSchema = z.object({
  pushToken: z.string().min(1).max(400),
});
export type RegisterPushTokenDto = z.infer<typeof RegisterPushTokenDtoSchema>;

/** Native "Sign in with Apple"/"Sign in with Google" — the mobile app posts the already-signed identity
 * token it got back from the on-device auth sheet; the server verifies it against the provider's JWKS
 * (see IdentityService.verifyAppleIdentityToken/verifyGoogleNativeIdentityToken). No redirect URI or code
 * here — unlike the web OAuth flows, there's no server-to-server exchange for these. */
export const NativeOAuthSignInDtoSchema = z.object({
  identityToken: z.string().min(1).max(4000),
});
export type NativeOAuthSignInDto = z.infer<typeof NativeOAuthSignInDtoSchema>;

/** Passkey (WebAuthn) ceremony payloads are the browser's own complex, nested JSON response objects —
 * @simplewebauthn/server's verify calls are themselves the real structural validation (they throw on
 * anything malformed), so these deliberately don't hand-duplicate that shape field by field. */
export const PasskeyRegisterDtoSchema = z.object({
  response: z.unknown(),
});
export type PasskeyRegisterDto = z.infer<typeof PasskeyRegisterDtoSchema>;

export const PasskeyAuthenticateDtoSchema = z.object({
  attemptId: z.string().min(1).max(200),
  response: z.unknown(),
});
export type PasskeyAuthenticateDto = z.infer<typeof PasskeyAuthenticateDtoSchema>;
