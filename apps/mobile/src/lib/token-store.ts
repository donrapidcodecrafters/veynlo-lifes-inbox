import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

const TOKEN_KEY = "veynlo_session_token";
const REFRESH_TOKEN_KEY = "veynlo_refresh_token";

/** §28.5 "Use ThisDeviceOnly accessibility for secrets that should not migrate through backups" — these
 * two secrets used to be stored with SecureStore's default (`WHEN_UNLOCKED`, which DOES travel through an
 * iCloud/iTunes device backup and restore onto a different physical device). A session/refresh token
 * restored onto someone else's phone via a backup would let them act as this account without ever
 * re-authenticating — `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps the secret bound to Secure Enclave state that
 * doesn't exist on any other device, so a restored backup simply has no usable value here. Android's
 * `expo-secure-store` implementation ignores this iOS-only option rather than erroring on it. */
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

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
    return SecureStore.getItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS);
  },
  async set(token: string): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(TOKEN_KEY, token);
      return;
    }
    await SecureStore.setItemAsync(TOKEN_KEY, token, SECURE_STORE_OPTIONS);
  },
  async clear(): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.removeItem(TOKEN_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(TOKEN_KEY, SECURE_STORE_OPTIONS);
  },
  /** §AUTH rotating refresh-token flow (services/api's `/v1/auth/refresh`) — stored alongside the access
   * token, same Keychain/Keystore tier, so a 401 can be recovered from without forcing a full password
   * re-authentication every ACCESS_TOKEN_TTL_SECONDS (14 days). */
  async getRefreshToken(): Promise<string | null> {
    if (Platform.OS === "web") return typeof localStorage !== "undefined" ? localStorage.getItem(REFRESH_TOKEN_KEY) : null;
    return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, SECURE_STORE_OPTIONS);
  },
  async setRefreshToken(token: string): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(REFRESH_TOKEN_KEY, token);
      return;
    }
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, SECURE_STORE_OPTIONS);
  },
  async clearRefreshToken(): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.removeItem(REFRESH_TOKEN_KEY);
      return;
    }
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, SECURE_STORE_OPTIONS);
  },
};
