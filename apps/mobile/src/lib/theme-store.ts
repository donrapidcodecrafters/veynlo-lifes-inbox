import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import type { ThemeMode } from "./theme";

// Reuses expo-secure-store (already integrated for the auth token in token-store.ts) rather than adding
// a new native dependency like AsyncStorage just for this — theme preference isn't sensitive, but this
// app already has a working, tested KV store, and the already-fragile Expo/RN native toolchain (three
// real upstream bugs patched earlier this session) isn't worth risking for a preference this small.
const THEME_KEY = "veynlo_theme_mode";

export const themeStore = {
  async get(): Promise<ThemeMode | null> {
    const raw =
      Platform.OS === "web"
        ? typeof localStorage !== "undefined"
          ? localStorage.getItem(THEME_KEY)
          : null
        : await SecureStore.getItemAsync(THEME_KEY);
    return raw === "light" || raw === "dark" || raw === "system" ? raw : null;
  },
  async set(mode: ThemeMode): Promise<void> {
    if (Platform.OS === "web") {
      if (typeof localStorage !== "undefined") localStorage.setItem(THEME_KEY, mode);
      return;
    }
    await SecureStore.setItemAsync(THEME_KEY, mode);
  },
};
