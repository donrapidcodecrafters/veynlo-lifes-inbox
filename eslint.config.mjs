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
   * The two type-aware promise rules, and only those two.
   *
   * The config above is `recommended`, not `recommendedTypeChecked`, so nothing here needed type
   * information — which also meant no-floating-promises was never running anywhere in this repo. An
   * un-awaited `db.insert(...)` is exactly the kind of defect this audit keeps turning up: silent,
   * invisible to any test that does not assert on the write, and indistinguishable from working code by
   * reading it.
   *
   * A one-off type-aware pass over services/api found ZERO floating promises in service code. The only
   * four findings were entry-point bootstrap calls and two async signal handlers (a rejecting
   * `worker.close()` would have skipped `process.exit(0)` and left the worker hanging until it was
   * SIGKILLed). Those are fixed, and these rules are added at that clean point so the state is kept
   * rather than rediscovered later. The rest of `recommendedTypeChecked` is deliberately left out: its
   * other 44 findings here were unnecessary type assertions, which is a style argument, not a correctness
   * one, and this config is a correctness gate.
   */
  {
    files: ["services/**/*.ts", "packages/**/*.ts"],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
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
  /**
   * Build/config files that are CommonJS by contract, not by choice. Metro's config and Expo's config
   * plugins are loaded by tooling that `require()`s them before any bundler or transpiler is involved, so
   * they cannot use ESM `import` — flagging `require()` in them is a false positive, not a finding.
   */
  {
    files: ["**/metro.config.js", "**/*.config.js", "apps/mobile/plugins/**/*.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
