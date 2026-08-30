// @ts-check
import tseslint from "typescript-eslint";
import reactNativeA11y from "eslint-plugin-react-native-a11y";

/**
 * Root flat config (ESLint 9) shared by every workspace package — each
 * package's `eslint src` picks this up automatically since flat config
 * resolution walks up from the linted directory. Kept deliberately light:
 * type-aware correctness rules, not a stylistic quality gate (Prettier
 * already owns formatting).
 */
export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/build/**",
      "**/*.d.ts",
      "**/drizzle.config.ts",
      "packages/db/src/migrations/**",
      // Metro/Expo config plugins run under Node's plain CJS loader before any bundler touches them —
      // genuinely require() rather than ESM import, same category as drizzle.config.ts above.
      "apps/mobile/metro.config.js",
      "apps/mobile/plugins/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off", // used deliberately in a handful of cross-package typing-friction spots, always commented
      "@typescript-eslint/no-empty-object-type": "off",
    },
  },
  {
    // §54.2 launch criterion 11 — React Native renders a native view tree, not a DOM, so jest-axe (used
    // for web's page-level a11y tests) simply doesn't apply here. This is mobile's equivalent automated
    // check: static analysis of RN's own accessibility API surface (accessibilityLabel/Role/State/etc.)
    // directly on the JSX, which is the standard tool for this gap in a codebase with no DOM to scan.
    files: ["apps/mobile/**/*.{ts,tsx}"],
    plugins: { "react-native-a11y": reactNativeA11y },
    rules: {
      "react-native-a11y/has-accessibility-props": "error",
      "react-native-a11y/has-valid-accessibility-actions": "error",
      "react-native-a11y/has-valid-accessibility-component-type": "error",
      "react-native-a11y/has-valid-accessibility-descriptors": "error",
      "react-native-a11y/has-valid-accessibility-role": "error",
      "react-native-a11y/has-valid-accessibility-state": "error",
      "react-native-a11y/has-valid-accessibility-states": "error",
      "react-native-a11y/has-valid-accessibility-traits": "error",
      "react-native-a11y/has-valid-accessibility-value": "error",
      "react-native-a11y/has-valid-accessibility-ignores-invert-colors": "error",
      "react-native-a11y/has-valid-accessibility-live-region": "error",
      "react-native-a11y/has-valid-important-for-accessibility": "error",
      "react-native-a11y/no-nested-touchables": "error",
      // Deliberately excluded: has-accessibility-hint requires an accessibilityHint on every accessible
      // element, which is overkill for controls whose accessibilityLabel is already self-explanatory
      // ("Confirm", "Dismiss") — the rule has no per-element escape hatch short of a suppression comment
      // on every button in the app, which would be noise, not signal.
    },
  },
);
