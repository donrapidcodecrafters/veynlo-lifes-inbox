// @ts-check
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

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
  /**
   * React hooks rules, scoped to the three React surfaces (web, admin, mobile).
   *
   * Registered because the code already depends on it: five files carry
   * `// eslint-disable-next-line react-hooks/exhaustive-deps`, and with the plugin absent ESLint treats a
   * disable directive for an unknown rule as an ERROR ("Definition for rule ... was not found"). That
   * broke `next build` for apps/web, which runs its own ESLint pass — a failure `pnpm -r run lint` could
   * never surface, since apps/web's lint script is currently a no-op.
   *
   * `rules-of-hooks` is an error (violating it is a real correctness bug); `exhaustive-deps` stays a
   * warning, which is what the existing disable comments assume.
   */
  {
    files: ["apps/web/**/*.{ts,tsx}", "apps/admin/**/*.{ts,tsx}", "apps/mobile/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
