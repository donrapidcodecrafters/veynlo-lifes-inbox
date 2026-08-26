import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import { resolveTheme, type AppTheme, type ThemeMode } from "./theme";

interface ThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  theme: AppTheme;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Preference is in-memory only for now (resets to "system" on app
 * restart) — persisting it (and syncing to the account-level
 * themePreference the web app already writes to) is a follow-up; see
 * docs/ROADMAP.md.
 */
export function AppThemeProvider({ children }: { children: ReactNode }) {
  const systemScheme = useColorScheme();
  const [mode, setMode] = useState<ThemeMode>("system");

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
