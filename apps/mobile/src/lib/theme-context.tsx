import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { resolveTheme, type AppTheme, type ThemeMode } from "./theme";
import { themeStore } from "./theme-store";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  theme: AppTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Persisted locally via expo-secure-store (see theme-store.ts) — matches apps/web's own theme
 * persistence, which is also local-only (browser localStorage), not synced to the account-level
 * `users.themePreference` column; that column exists in the schema but nothing writes to it on either
 * platform today, so "sync across devices" is a separate, larger follow-up, not what this fixes.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    themeStore.get().then((stored) => {
      if (stored) setModeState(stored);
    });
  }, []);

  const setMode = (next: ThemeMode) => {
    setModeState(next);
    themeStore.set(next);
  };

  const resolvedMode = mode === "system" ? (systemScheme === "dark" ? "dark" : "light") : mode;
  const theme = useMemo(() => resolveTheme(resolvedMode), [resolvedMode]);
  const value = useMemo(() => ({ mode, setMode, theme }), [mode, theme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useAppTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useAppTheme must be used within AppThemeProvider");
  return ctx;
}
