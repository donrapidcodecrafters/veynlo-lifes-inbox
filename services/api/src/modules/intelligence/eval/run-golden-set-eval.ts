/**
 * §39.2 "Model routing, versioning and evaluation" — "Per-domain offline evaluation suites include
 * precision/recall of fields, date/amount exactness, entity-linking precision, false critical alert rate,
 * and calibration by confidence band." Before this script existed, this codebase's ONLY automated coverage
 * of the AI extraction pipeline was unit tests of code logic around the model (schema-repair retry, dedup,
 * confidence-band mapping, `FakeModelProvider`-driven tests) — never a real check that the model itself
 * still extracts a receipt/bill/event/subscription/warranty correctly. A prompt tweak or a model swap could
 * silently degrade extraction quality with nothing to catch it. This is that check.
 *
 * WHAT THIS DOES: loads the hand-authored golden-set fixtures in ./golden-set/*.json, runs each one through
 * the REAL `AnthropicExtractionService` (the exact same class, schema-repair retry, and — for each schema
 * below — the exact same system prompt `IngestionService` uses in production), scores the actual output
 * against each fixture's expected fields (see ./score.ts), prints a per-case and per-schema report, and
 * persists one summary row to `model_eval_runs` (surfaced in the admin dashboard's "Extraction quality
 * evals" section) so a regression after a prompt/model change is a visible trend line, not a silent
 * surprise.
 *
 * *** THIS MAKES REAL, BILLABLE ANTHROPIC API CALLS — ONE PER GOLDEN CASE. ***
 * This is INTENTIONALLY NOT part of `pnpm test` / the default vitest suite, and must never be added to a
 * pre-commit hook or a per-PR CI job that runs on every push — that would spend real API budget on every
 * commit for no benefit. This is a QUALITY GATE meant to be run:
 *   - manually, by a human, before shipping a prompt or extraction-schema change for one of the schemas
 *     below;
 *   - manually, before bumping the model behind a routing tier in `model_registry` (§39.2 "production
 *     canaries compare new model output ... before changing canonical extraction behavior" — this script IS
 *     that canary check for prompt/schema/model changes, run ahead of time rather than on live traffic);
 *   - or from an unattended SCHEDULED job (e.g. nightly/weekly) that alerts a human on a real pass-rate
 *     drop, not a job whose failure silently disappears into logs nobody reads.
 * A green run here is a genuine signal that extraction quality held; treat a red run as a real regression
 * to investigate, not something to re-run until it passes or to quietly ignore — that would make this
 * decorative instead of a real gate. (Some genuine, expected variance from run to run is normal — this
 * calls a real, non-deterministic model — but a case that fails repeatedly across runs is a real problem.)
 *
 * Usage (from services/api/):
 *   pnpm run eval:extraction                  # every schema, every golden case
 *   pnpm run eval:extraction --schema=receipt  # only one schema's golden set
 *   pnpm run eval:extraction --limit=2         # only the first N cases per schema (cheap smoke check)
 *
 * Exit code is non-zero whenever any case fails, so a scheduled job can alert on a non-zero exit rather
 * than parsing output.
 */
import "../../../config/load-env-file"; // must be the first import — see its own doc comment for why
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createDbClient, schema } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { loadEnv } from "../../../config/env";
import { AnthropicExtractionService } from "../anthropic-extraction.service";
import { EVAL_SCHEMAS } from "./eval-schemas";
import { scoreCase, type CaseResult } from "./score";
import type { GoldenCase } from "./golden-set-types";

/** A label for which version of the golden set + prompts this run exercised — bump this string when the
 * golden-set fixtures or their expected values change meaningfully, so a later run's `model_eval_runs` row
 * is told apart from a run against a different golden set in the admin history view. */
const GOLDEN_SET_VERSION = "golden_set_v1";

/** Caps how many individual field failures get persisted per run — a badly-regressed run (e.g. every case
 * failing) could otherwise write an unbounded JSON blob; the console output above already has the full
 * detail for a human debugging a live run, this cap only bounds what's kept in the DB long-term. */
const MAX_PERSISTED_FIELD_FAILURES = 200;

function loadGoldenCases(fileName: string): GoldenCase[] {
  const filePath = join(__dirname, "golden-set", fileName);
  return JSON.parse(readFileSync(filePath, "utf-8")) as GoldenCase[];
}

function argValue(flag: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${flag}=`));
  return arg?.slice(flag.length + 3);
}

async function main() {
  const env = loadEnv();
  if (!env.ANTHROPIC_API_KEY) {
    // A real quality gate must fail loudly when it can't actually run — reporting a fake "0 cases, 100%
    // pass" here would be worse than not running at all, since it would look identical to a genuinely
    // healthy run in the admin dashboard's history.
    console.error(
      "ANTHROPIC_API_KEY is not configured. This eval harness makes real, billable Anthropic API calls " +
        "and cannot meaningfully run without a real key — refusing to report a false pass. Set " +
        "ANTHROPIC_API_KEY in services/api/.env (or the environment) and re-run.",
    );
    process.exit(1);
  }

  const onlySchema = argValue("schema");
  const limitArg = argValue("limit");
  const limit = limitArg ? Number(limitArg) : undefined;

  const db = createDbClient(env.DATABASE_URL);
  const ai = new AnthropicExtractionService(db);

  const configs = onlySchema ? EVAL_SCHEMAS.filter((c) => c.schemaName === onlySchema) : EVAL_SCHEMAS;
  if (configs.length === 0) {
    console.error(`No golden-set schema named "${onlySchema}". Known schemas: ${EVAL_SCHEMAS.map((c) => c.schemaName).join(", ")}`);
    process.exit(1);
  }

  const allResults: CaseResult[] = [];
  const bySchema: Array<{ schemaName: string; total: number; passed: number; passRate: number }> = [];
  let lastModelUsed: string | null = null;

  for (const config of configs) {
    const allCases = loadGoldenCases(config.goldenSetFile);
    const cases = limit ? allCases.slice(0, limit) : allCases;
    console.log(`\n--- ${config.schemaName} (${cases.length} case${cases.length === 1 ? "" : "s"}) ---`);

    let passed = 0;
    for (const goldenCase of cases) {
      // No `sourceEventId` — this is synthetic golden-set content with no real `source_events` row to
      // attribute a run to, the same "uninstrumented by design" posture StructuredExtractionRequest's own
      // doc comment describes for documents.service.ts's OCR calls and search.service.ts's Ask synthesis.
      const result = await ai.extractStructured({
        extractorName: config.extractorName,
        systemPrompt: config.systemPrompt,
        userContent: `Subject: ${goldenCase.subject}\n\nBody:\n${goldenCase.body}`,
        schema: config.zodSchema,
        toolDescription: config.toolDescription,
        model: "cheap", // matches every one of these five real extractors' own choice of tier
      });

      if (!result) {
        const caseResult: CaseResult = {
          caseId: goldenCase.id,
          schemaName: config.schemaName,
          pass: false,
          fields: [{ field: "(extraction)", expected: "a structured result", actual: null, pass: false }],
        };
        allResults.push(caseResult);
        console.log(`  FAIL  ${goldenCase.id} — model returned no usable extraction (not configured, no tool_use, or invalid output)`);
        continue;
      }

      lastModelUsed = result.modelUsed;
      const caseResult = scoreCase(goldenCase.id, config.schemaName, goldenCase.expected, result.data as Record<string, unknown>);
      allResults.push(caseResult);
      if (caseResult.pass) passed += 1;
      console.log(`  ${caseResult.pass ? "PASS" : "FAIL"}  ${goldenCase.id}`);
      for (const field of caseResult.fields.filter((f) => !f.pass)) {
        console.log(`        field '${field.field}': expected ${JSON.stringify(field.expected)}, got ${JSON.stringify(field.actual)}`);
      }
    }
    bySchema.push({ schemaName: config.schemaName, total: cases.length, passed, passRate: cases.length > 0 ? passed / cases.length : 0 });
  }

  const totalCases = allResults.length;
  const passedCases = allResults.filter((r) => r.pass).length;
  const passRate = totalCases > 0 ? passedCases / totalCases : 0;

  console.log("\n=== Golden-set eval summary ===");
  for (const s of bySchema) console.log(`  ${s.schemaName}: ${s.passed}/${s.total} (${Math.round(s.passRate * 100)}%)`);
  console.log(`  TOTAL: ${passedCases}/${totalCases} (${Math.round(passRate * 100)}%)`);

  const fieldFailures = allResults
    .flatMap((r) => r.fields.filter((f) => !f.pass).map((f) => ({ caseId: r.caseId, schemaName: r.schemaName, field: f.field, expected: f.expected, actual: f.actual })))
    .slice(0, MAX_PERSISTED_FIELD_FAILURES);

  await db.insert(schema.modelEvalRuns).values({
    id: generateId("modelEvalRun"),
    modelKey: lastModelUsed ?? "unknown",
    goldenSetVersion: GOLDEN_SET_VERSION,
    totalCases,
    passedCases,
    passRate,
    bySchema,
    fieldFailures,
    triggeredBy: process.env.USER ?? process.env.CI_JOB_ID ?? "manual",
  });
  console.log("\nRecorded this run in model_eval_runs (visible in the admin dashboard's 'Extraction quality evals' section).");

  process.exit(passRate === 1 ? 0 : 1);
}

main().catch((err) => {
  console.error("Golden-set eval run failed:", err);
  process.exit(1);
});
