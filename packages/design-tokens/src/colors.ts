/**
 * Veynlo color primitives and semantic tokens.
 *
 * Palette intent: calm, trustworthy, premium. A single desaturated indigo
 * brand hue, a warm neutral gray ramp (not pure gray — keeps dark mode from
 * looking clinical), and five semantic accents that stay distinguishable
 * without turning the UI into a control panel.
 *
 * Dark mode is a deliberate re-composition, not an inversion: surfaces step
 * up from a near-black base rather than using inverted light-mode grays,
 * and accent colors are individually re-tuned for contrast/vibrancy on dark
 * surfaces (see darkSemanticColors).
 */

export const brand = {
  50: "#f2f4ff",
  100: "#e6e9fe",
  200: "#c9cffc",
  300: "#a3adf8",
  400: "#7c86f0",
  500: "#5b63e3", // primary brand
  600: "#464dc4",
  700: "#383da0",
  800: "#2e3280",
  900: "#282b68",
  950: "#181a3d",
} as const;

export const neutral = {
  0: "#ffffff",
  50: "#f8f8fb",
  100: "#f0f1f5",
  150: "#e7e8ee",
  200: "#dcdee6",
  300: "#c2c5d1",
  400: "#9a9dad",
  500: "#75788a",
  600: "#585b6d",
  700: "#404253",
  750: "#3a3c4d",
  800: "#2a2c3a",
  850: "#20212c",
  900: "#17181f",
  950: "#0e0f14",
  1000: "#000000",
} as const;

export const semantic = {
  critical: {
    50: "#fef2f2",
    100: "#fde3e3",
    300: "#f5a3a3",
    500: "#d64545",
    600: "#b83636",
    700: "#8f2929",
  },
  warning: {
    50: "#fff8ec",
    100: "#fdecc8",
    300: "#f2c569",
    500: "#c98a1f",
    600: "#a06c15",
    700: "#7a5210",
  },
  info: {
    50: "#eff6ff",
    100: "#dbeafe",
    300: "#93c5fd",
    500: "#3b82f6",
    600: "#2563cf",
    700: "#1d4ea8",
  },
  positive: {
    50: "#eefbf3",
    100: "#d3f4e0",
    300: "#7fd8a8",
    500: "#2f9e63",
    600: "#25824f",
    700: "#1c633c",
  },
  neutralAccent: {
    50: "#f5f5f7",
    100: "#e8e8ee",
    300: "#b7b9c9",
    500: "#6b6e82",
    600: "#54566a",
    700: "#3f4152",
  },
} as const;

/** Light-theme semantic surface/text/border roles. */
export const lightSemanticColors = {
  bgCanvas: neutral[50],
  bgSurface: neutral[0],
  bgSurfaceRaised: neutral[0],
  bgSubtle: neutral[100],
  bgOverlay: "rgba(23, 24, 31, 0.48)",
  bgInverse: neutral[900],

  borderSubtle: neutral[150],
  borderDefault: neutral[200],
  borderStrong: neutral[300],
  borderFocus: brand[500],

  textPrimary: neutral[900],
  textSecondary: neutral[600],
  textTertiary: neutral[500],
  textDisabled: neutral[400],
  textInverse: neutral[0],
  textOnBrand: neutral[0],

  brandDefault: brand[500],
  brandHover: brand[600],
  brandActive: brand[700],
  brandSubtleBg: brand[50],
  brandSubtleText: brand[700],

  critical: semantic.critical[500],
  criticalSubtleBg: semantic.critical[50],
  criticalSubtleText: semantic.critical[700],
  // Deliberately the SAME value in both lightSemanticColors and darkSemanticColors — unlike `critical`
  // (which is intentionally re-tuned per mode as a foreground/text color, and much too pale in dark mode
  // to double as a button fill), this is for a solid destructive-button background that needs to stay dark
  // enough for white text on top in both themes. See criticalSolid below for the failure this fixes.
  criticalSolid: semantic.critical[600],
  warning: semantic.warning[500],
  warningSubtleBg: semantic.warning[50],
  warningSubtleText: semantic.warning[700],
  info: semantic.info[500],
  infoSubtleBg: semantic.info[50],
  infoSubtleText: semantic.info[700],
  positive: semantic.positive[500],
  positiveSubtleBg: semantic.positive[50],
  positiveSubtleText: semantic.positive[700],

  focusRing: brand[400],
} as const;

/** Dark-theme semantic surface/text/border roles — composed, not inverted. */
export const darkSemanticColors = {
  bgCanvas: neutral[950],
  bgSurface: neutral[900],
  bgSurfaceRaised: neutral[850],
  bgSubtle: neutral[850],
  bgOverlay: "rgba(4, 4, 6, 0.6)",
  bgInverse: neutral[50],

  borderSubtle: neutral[850],
  borderDefault: neutral[750],
  borderStrong: neutral[600],
  borderFocus: brand[400],

  textPrimary: neutral[50],
  textSecondary: neutral[300],
  textTertiary: neutral[400],
  textDisabled: neutral[600],
  textInverse: neutral[900],
  textOnBrand: neutral[0],

  brandDefault: brand[400],
  brandHover: brand[300],
  brandActive: brand[200],
  brandSubtleBg: "rgba(91, 99, 227, 0.16)",
  brandSubtleText: brand[300],

  critical: "#e9807f",
  criticalSubtleBg: "rgba(214, 69, 69, 0.16)",
  criticalSubtleText: "#f4b3b2",
  // Same fixed value as lightSemanticColors.criticalSolid — see that comment for why this one doesn't flip.
  criticalSolid: semantic.critical[600],
  warning: "#e8b463",
  warningSubtleBg: "rgba(201, 138, 31, 0.16)",
  warningSubtleText: "#f0cf94",
  info: "#7fb1fb",
  infoSubtleBg: "rgba(59, 130, 246, 0.16)",
  infoSubtleText: "#b7d3fd",
  positive: "#6bc793",
  positiveSubtleBg: "rgba(47, 158, 99, 0.16)",
  positiveSubtleText: "#a6e2c1",

  focusRing: brand[300],
} as const;

export type SemanticColorToken = keyof typeof lightSemanticColors;
