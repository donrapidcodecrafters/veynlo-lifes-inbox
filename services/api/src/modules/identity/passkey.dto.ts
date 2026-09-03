import { z } from "zod";

/**
 * AUTH-001 "create passkey" — request bodies for the WebAuthn registration/authentication ceremonies.
 * `response` is left as `z.unknown()` deliberately: it's the browser-native
 * `RegistrationResponseJSON`/`AuthenticationResponseJSON` shape `@simplewebauthn/browser`'s
 * `startRegistration`/`startAuthentication` produce — a deeply-nested structure with base64url-encoded
 * binary fields that `@simplewebauthn/server`'s own `verifyRegistrationResponse`/
 * `verifyAuthenticationResponse` already validates structurally (and cryptographically) far more
 * thoroughly than a hand-written Zod schema could; PasskeyService wraps that call in a try/catch and maps
 * any malformed-input error to a clear 400, so nothing here needs to duplicate that validation.
 */
export const PasskeyRegistrationVerifyDtoSchema = z.object({
  response: z.unknown(),
  challengeToken: z.string().min(1),
  // A user-facing nickname for this credential (e.g. "Chrome on MacBook"), derived client-side from the
  // browser/OS at registration time — optional, since a browser that can't infer one just omits it.
  label: z.string().max(200).nullable().optional(),
});
export type PasskeyRegistrationVerifyDto = z.infer<typeof PasskeyRegistrationVerifyDtoSchema>;

export const PasskeyAuthenticationOptionsDtoSchema = z.object({
  // Optional — when provided, scopes `allowCredentials` to that account's own passkeys (a slightly better
  // "here's a hint of which passkey to use" UX); omitted entirely, this is a genuine discoverable-
  // credential ("usernameless") flow, which is the more phishing-resistant default this app prefers.
  email: z.string().email().nullable().optional(),
});
export type PasskeyAuthenticationOptionsDto = z.infer<typeof PasskeyAuthenticationOptionsDtoSchema>;

export const PasskeyAuthenticationVerifyDtoSchema = z.object({
  response: z.unknown(),
  challengeToken: z.string().min(1),
});
export type PasskeyAuthenticationVerifyDto = z.infer<typeof PasskeyAuthenticationVerifyDtoSchema>;
