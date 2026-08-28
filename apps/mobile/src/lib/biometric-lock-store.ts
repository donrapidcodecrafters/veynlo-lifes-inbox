import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

// Same rationale as theme-store.ts: reuses the already-integrated expo-secure-store rather than adding a
// new native dependency for one boolean preference.
const BIOMETRIC_LOCK_KEY = "veynlo_biometric_lock_enabled";

export const biometricLockStore = {
  async get(): Promise<boolean> {
    const raw =
      Platform.OS === "web"
        ? typeof localStorage !== "undefined"
          ? localStorage.getItem(BIOMETRIC_LOCK_KEY)
          : null
        : await SecureStore.getItemAsync(BIOMETRIC_LOCK_KEY);
    return raw === "true";
  },
  async set(enabled: boolean): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(BIOMETRIC_LOCK_KEY, String(enabled));
      return;
    }
    await SecureStore.setItemAsync(BIOMETRIC_LOCK_KEY, String(enabled));
  },
};
