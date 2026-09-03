import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// Same rationale as theme-store.ts: reuses the already-integrated expo-secure-store rather than adding a
// new native dependency for one boolean preference.
const BIOMETRIC_LOCK_KEY = "veynlo_biometric_lock_enabled";

// §28.5 — lower-stakes than token-store.ts's actual credentials (this is just a UI preference, not a
// secret whose leakage matters), but there's no reason a restored backup on a different device should
// silently inherit "biometric lock was on" as a stale, device-specific claim either — see
// token-store.ts's identical constant for the fuller rationale.
const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

export const biometricLockStore = {
  async get(): Promise<boolean> {
    const raw =
      Platform.OS === "web"
        ? typeof localStorage !== "undefined"
          ? localStorage.getItem(BIOMETRIC_LOCK_KEY)
          : null
        : await SecureStore.getItemAsync(BIOMETRIC_LOCK_KEY, SECURE_STORE_OPTIONS);
    return raw === "true";
  },
  async set(enabled: boolean): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(BIOMETRIC_LOCK_KEY, String(enabled));
      return;
    }
    await SecureStore.setItemAsync(BIOMETRIC_LOCK_KEY, String(enabled), SECURE_STORE_OPTIONS);
  },
};
