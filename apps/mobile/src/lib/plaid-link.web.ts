import type { PlaidLinkResult } from "./plaid-link.types";

/**
 * Web stub — resolved by Metro instead of `plaid-link.native.ts` whenever this module is imported from
 * code running under `expo start --web` (this app's Expo web preview, used throughout this session's
 * testing; not the separate apps/web Next.js app, which has its own real Plaid Link widget integration).
 *
 * `react-native-plaid-link-sdk` is a native-only module built on Expo Modules: its entry point calls
 * `requireNativeModule("ReactNativePlaidLinkSdk")` at import time (unconditionally, not lazily — see the
 * SDK's own `ReactNativePlaidLinkSdkModule.js`), which throws immediately under react-native-web since no
 * such native module is registered there. A runtime `Platform.OS === "web"` check inside a single shared
 * module (the pattern `android-share-intent-drain.tsx` uses for `expo-share-intent`, which stays safe to
 * import on every platform) isn't enough to prevent that — the import itself is what throws, before any
 * `if` statement in this app's own code would run. Metro's platform-specific extension resolution
 * (`.native.ts` / `.web.ts`) picks the right file per platform at bundle time instead, so the real SDK is
 * never even referenced in a web bundle.
 */
export const plaidLinkAvailable = false;

export async function openPlaidLink(_linkToken: string): Promise<PlaidLinkResult> {
  return {
    status: "error",
    message: "Bank connections aren't available in this preview. Use the installed app, or connect from veynlo.com on the web.",
  };
}
