import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "veynlo_session_token";

/**
 * Native has no browser cookie jar, so the bearer token issued by
 * /v1/auth/sign-in|sign-up (only for non-web platforms — see
 * services/api/src/modules/identity/identity.controller.ts) lives in
 * Keychain (iOS) / Keystore (Android) via SecureStore, never AsyncStorage.
 *
 * The web branch exists only so this same code runs under `expo start
 * --web` for local development/preview — the actual Veynlo web product is
 * the separate Next.js app (apps/web) using httpOnly cookies, which remains
 * the right approach for a real browser deployment.
 */
export const tokenStore = {
  async get(): Promise<string | null> {
    if (Platform.OS === "web") return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
    return SecureStore.getItemAsync(TOKEN_KEY);
  },
  async set(token: string): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token);
      return;
    }
    await SecureStore.setItemAsync(TOKEN_KEY, token);
  },
  async clear(): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  },
};
