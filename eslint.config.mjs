// @ts-check
import tseslint from "typescript-eslint";

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
);
