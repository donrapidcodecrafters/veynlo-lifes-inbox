/**
 * A real, previously-undiscovered bug: nothing in this codebase ever actually loaded `.env` into
 * `process.env` — no `dotenv` import anywhere, no `--env-file` flag on any script. `.env.example`'s own
 * instructions ("Copy to .env and fill in real values") silently did nothing: every value in `env.ts`'s
 * `EnvSchema` that has a `.default(...)` happened to already match `.env.example`, which is exactly why
 * this went unnoticed — the app *looked* like it was reading `.env`, but was actually only ever running
 * on schema defaults (or genuine shell-exported env vars, which Node sees regardless of any `.env` file).
 * Any optional integration a developer configured via `.env` — a real Google/Microsoft OAuth client, an
 * Anthropic key, Stripe keys, ClamAV, inbound email — would silently report "not configured" no matter
 * what was actually in the file, with no error pointing at why.
 *
 * A first attempt at fixing this called a `loadDotEnvFile()` function as the first line of `bootstrap()`
 * in main.ts/worker-main.ts — that was *still too late*. `env.ts`'s `loadEnv()` caches its result forever
 * (`let cached: Env | null = null`), and `logging.module.ts`'s `@Module()` decorator calls `loadEnv()` as
 * a *static decorator argument* (`PinoLoggerModule.forRoot({ level: loadEnv().LOG_LEVEL, ... })`) — decorator
 * arguments evaluate at class-declaration time, which happens while `AppModule`'s import graph is being
 * resolved, and that resolution completes before `bootstrap()`'s own body ever runs (importing a module
 * fully evaluates it first). So the first real call to `loadEnv()` — and therefore the permanent cache —
 * happened during `import { AppModule } from "./app.module"`, strictly before any code inside `bootstrap()`
 * could run, no matter how early in that function's body the fix was placed.
 *
 * The actual fix: run this as a side-effect import (`import "./config/load-env-file"`), and make it the
 * very FIRST import in main.ts/worker-main.ts, before even `reflect-metadata`. This project compiles to
 * CommonJS (`tsconfig.lib.json`'s `"module": "CommonJS"`), where `import` becomes `require()` and multiple
 * `require()` calls in one file execute strictly in the order they're written — unlike true ESM, where
 * every import's side effects are hoisted before any of the importing module's own code regardless of
 * position. Because this file's `.env` load happens as top-level code (not inside an exported function),
 * requiring it first guarantees it runs — and completes — before `require("./app.module")` even begins,
 * so every module's top-level/decorator-time code (including `logging.module.ts`'s) sees the loaded
 * environment.
 *
 * Uses Node's own built-in `process.loadEnvFile` (stable since Node 20.6) rather than adding a `dotenv`
 * dependency — feature-detected since this package's `engines.node` only guarantees `>=20.0.0`, slightly
 * older than when this API landed. Missing/absent `.env` is expected and fine in every non-local
 * environment (staging/production get secrets from the platform's own secrets manager, injected directly
 * into `process.env` — see docs/DEPLOYMENT.md), so a missing file is silently ignored, not an error.
 */
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // No .env file in this working directory — expected outside local dev.
  }
}
