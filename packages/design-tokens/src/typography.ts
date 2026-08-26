export const fontFamily = {
  sans: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  mono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
} as const;

/** Type scale — major-second-ish progression tuned for calm, readable UI. */
export const fontSize = {
  xs: { size: 12, lineHeight: 16 },
  sm: { size: 13, lineHeight: 18 },
  base: { size: 15, lineHeight: 22 },
  md: { size: 16, lineHeight: 24 },
  lg: { size: 18, lineHeight: 26 },
  xl: { size: 20, lineHeight: 28 },
  "2xl": { size: 24, lineHeight: 32 },
  "3xl": { size: 30, lineHeight: 38 },
  "4xl": { size: 36, lineHeight: 44 },
  "5xl": { size: 46, lineHeight: 54 },
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const letterSpacing = {
  tight: -0.02,
  normal: 0,
  wide: 0.02,
} as const;

export type FontSizeToken = keyof typeof fontSize;
export type FontWeightToken = keyof typeof fontWeight;
