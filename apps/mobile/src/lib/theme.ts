import { lightSemanticColors, darkSemanticColors, semantic, space, radius } from "@veynlo/design-tokens";

/**
 * The same token source the web app themes off of (`@veynlo/design-tokens`),
 * just consumed as plain values instead of CSS custom properties — React
 * Native has no CSS cascade, so there's no equivalent of the web's
 * `data-theme` attribute trick. `useAppTheme()` below picks the palette
 * once per render based on the OS color scheme + the user's override.
 */
export type ThemeMode = "system" | "light" | "dark";

export interface AppTheme {
  mode: "light" | "dark";
  colors: Record<keyof typeof lightSemanticColors, string> & {
    critical: string;
    criticalSubtleBg: string;
    warning: string;
    warningSubtleBg: string;
  };
  space: typeof space;
  radius: typeof radius;
}

export function resolveTheme(mode: "light" | "dark"): AppTheme {
  const base = mode === "dark" ? darkSemanticColors : lightSemanticColors;
  return {
    mode,
    colors: {
      ...base,
      critical: semantic.critical[500],
      criticalSubtleBg: semantic.critical[50],
      warning: semantic.warning[500],
      warningSubtleBg: semantic.warning[50],
    },
    space,
    radius,
  };
}
