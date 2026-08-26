/** Base spacing unit is 4px; scale covers dense desktop tables through spacious mobile cards. */
export const space = {
  0: 0,
  0.5: 2,
  1: 4,
  1.5: 6,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
  16: 64,
  20: 80,
  24: 96,
  32: 128,
} as const;

export const radius = {
  none: 0,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  "2xl": 28,
  full: 9999,
} as const;

/** Elevation is used sparingly — most surfaces rely on borders, not shadows. */
export const shadow = {
  none: "none",
  xs: "0 1px 2px rgba(15, 15, 20, 0.06)",
  sm: "0 2px 6px rgba(15, 15, 20, 0.08)",
  md: "0 6px 16px rgba(15, 15, 20, 0.10)",
  lg: "0 16px 32px rgba(15, 15, 20, 0.14)",
  focusRing: "0 0 0 3px",
} as const;

export const motion = {
  duration: {
    instant: 80,
    fast: 140,
    base: 200,
    slow: 320,
    deliberate: 480,
  },
  easing: {
    standard: "cubic-bezier(0.2, 0, 0, 1)",
    decelerate: "cubic-bezier(0, 0, 0, 1)",
    accelerate: "cubic-bezier(0.3, 0, 1, 1)",
  },
} as const;

export const breakpoint = {
  xs: 0,
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

/** Max content widths per breakpoint — desktop uses multi-pane layouts, not a stretched phone column. */
export const layoutWidth = {
  content: 720,
  panel: 960,
  wide: 1200,
  full: 1440,
} as const;

export const iconSize = {
  xs: 14,
  sm: 16,
  md: 20,
  lg: 24,
  xl: 32,
} as const;

/** Minimum touch target — meets WCAG 2.2 AA (24x24 minimum; 44x44 for primary mobile actions). */
export const touchTarget = {
  minimum: 24,
  comfortable: 40,
  primaryMobile: 44,
} as const;

export const formControlHeight = {
  sm: 32,
  md: 40,
  lg: 48,
} as const;

export const zIndex = {
  base: 0,
  dropdown: 100,
  sticky: 200,
  overlay: 300,
  modal: 400,
  popover: 500,
  toast: 600,
  tooltip: 700,
} as const;
