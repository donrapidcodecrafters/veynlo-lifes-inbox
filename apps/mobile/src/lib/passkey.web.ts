import type { RegistrationOptionsJSON, AuthenticationOptionsJSON, PasskeyRegistrationResult, PasskeyAuthenticationResult } from "./passkey.types";

/**
 * Web stub — resolved by Metro instead of `passkey.native.ts` whenever this module is imported from code
 * running under `expo start --web`. Same reasoning as `plaid-link.web.ts`: `react-native-passkey` is a
 * native-only module (its `NativePasskey` binding is required at import time), so a runtime
 * `Platform.OS === "web"` check inside one shared module isn't enough — the import itself would throw
 * before any such check could run. Metro's platform-extension resolution picks this file instead, so the
 * real native module is never referenced in a web bundle at all.
 *
 * Note this is the Expo-web PREVIEW of the mobile app (`expo start --web`), a different build entirely
 * from `apps/web`'s real Next.js app, which has its own genuine `@simplewebauthn/browser`-backed passkey
 * implementation (see apps/web/src/app/(auth)/sign-in/page.tsx) — passkeys work perfectly well in a real
 * desktop/mobile browser, just not inside this particular React-Native-for-web preview target.
 */
export const passkeyAvailable = false;

export function isPasskeySupported(): boolean {
  return false;
}

export async function registerPasskey(_options: RegistrationOptionsJSON): Promise<PasskeyRegistrationResult> {
  return { status: "error", message: "Passkeys aren't available in this preview. Use the installed app, or add one from veynlo.com on the web." };
}

export async function authenticatePasskey(_options: AuthenticationOptionsJSON): Promise<PasskeyAuthenticationResult> {
  return { status: "error", message: "Passkeys aren't available in this preview. Use the installed app, or sign in from veynlo.com on the web." };
}
