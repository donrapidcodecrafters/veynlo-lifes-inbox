import { pgTable, text, timestamp, integer, real, jsonb } from "drizzle-orm/pg-core";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

export const extractorVersions = pgTable("extractor_versions", {
  id: text("id").primaryKey(),
  stage: text("stage").notNull(),
  name: text("name").notNull(),
  version: text("version").notNull(),
  modelKey: text("model_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
});

export const extractionRuns = pgTable("extraction_runs", {
  id: text("id").primaryKey(),
  sourceEventId: text("source_event_id").notNull(),
  stage: text("stage").notNull(),
  extractorVersionId: text("extractor_version_id")
    .notNull()
    .references(() => extractorVersions.id),
  status: text("status").notNull().default("pending"),
  costMinorUnits: integer("cost_minor_units"),
  latencyMs: integer("latency_ms"),
  outputJson: encryptedJsonb<unknown>("output_json", null),
  errorDetail: encryptedText("error_detail"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

/** Per-domain/field risk policy (§AI-002) — versioned so historical decisions stay explainable. */
export const riskPolicies = pgTable("risk_policies", {
  id: text("id").primaryKey(),
  domain: text("domain").notNull(),
  field: text("field").notNull(),
  autoAcceptThreshold: real("auto_accept_threshold").notNull(),
  reviewThreshold: real("review_threshold").notNull(),
  policyVersion: text("policy_version").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §39.2 "Model routing, versioning and evaluation" first bullet, verbatim: "Maintain a model registry
 * containing provider, model/version, supported tasks, max context, structured-output reliability,
 * latency class, cost class, regions, privacy/retention settings, launch status, and deprecation date."
 *
 * Before this table existed, `MODEL_BY_TIER` in anthropic-extraction.service.ts was a bare hardcoded
 * `{ cheap: "...", reasoning: "..." }` object — no metadata at all, and retiring or swapping a model meant
 * shipping code. This is the registry: one row per model this codebase actually calls, keyed by `tier` —
 * the same "cheap"/"reasoning" routing concept `MODEL_BY_TIER` already used — so
 * `AnthropicExtractionService.resolveModelForTier` can resolve "the current model for this tier" as a data
 * read. The routing DECISION (which tier a given extraction call needs) stays real code, exactly as
 * before; only the concrete model id/metadata behind a tier becomes data.
 *
 * Per-token pricing is DELIBERATELY NOT duplicated here. `MODEL_PRICING_USD_PER_MILLION_TOKENS` in
 * anthropic-extraction.service.ts remains the one source of truth for cost — keyed by the exact same
 * `modelKey` string this table uses — so a registry row and its real cost figure can never drift apart by
 * having two places that both claim to know a model's price. `costClass` below is a coarse, descriptive
 * band for display only (e.g. an admin screen), never read for billing math.
 */
export const modelRegistry = pgTable("model_registry", {
  id: text("id").primaryKey(),
  provider: text("provider").notNull(), // e.g. "anthropic"
  // Same literal string as extractorVersions.modelKey / extraction_runs pricing lookup / the Anthropic API's
  // own model id (e.g. "claude-haiku-4-5-20251001") — the join key every other model-keyed table already uses.
  modelKey: text("model_key").notNull().unique(),
  // The routing tier this row currently serves — "cheap" | "reasoning" today, matching
  // StructuredExtractionRequest.model's own two literal values. Not a foreign key/enum on purpose: adding a
  // third tier is a data+code change together (a new tier literal has to exist in code to ever be
  // requested), but which MODEL currently answers an existing tier is purely this table's job.
  tier: text("tier").notNull(),
  displayName: text("display_name").notNull(),
  // e.g. ["domain_classification", "structured_extraction", "ask_synthesis", "agent_planning"].
  supportedTasks: jsonb("supported_tasks").$type<string[]>().notNull().default([]),
  maxContextTokens: integer("max_context_tokens").notNull(),
  // Coarse, human-judged bands — §39.2's own list, not a calibrated statistic (that's the separate
  // per-domain offline eval suite this same chapter calls for; see model_eval_runs below).
  structuredOutputReliability: text("structured_output_reliability").notNull(), // "high" | "medium" | "low"
  latencyClass: text("latency_class").notNull(), // "fast" | "standard" | "slow"
  costClass: text("cost_class").notNull(), // "low" | "medium" | "high" — display band only, see doc comment above
  regions: jsonb("regions").$type<string[]>().notNull().default([]), // e.g. ["us"]
  privacyRetentionNote: text("privacy_retention_note"), // free text, e.g. Anthropic's own data-retention terms for API traffic
  launchStatus: text("launch_status").notNull().default("ga"), // "ga" | "beta" | "preview"
  // Informational only — flags a model as being phased out without yet removing it from rotation. Doesn't
  // affect `resolveModelForTier`; a deprecated-but-not-sunset model is still selected normally so an
  // operator can watch a phase-out land on a schedule instead of atomically.
  deprecatedAt: timestamp("deprecated_at", { withTimezone: true }),
  // §39.2 "Global kill switch must disable a model or task without client release" — the operational kill
  // switch. `resolveModelForTier` excludes any row with `sunsetAt` set, so retiring a model is one `UPDATE`,
  // not a deploy. If a tier's only row(s) are all sunset, resolution falls back to the hardcoded
  // `DEFAULT_MODEL_BY_TIER` safety net rather than returning nothing (see that constant's own doc comment).
  sunsetAt: timestamp("sunset_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * §39.2 "Per-domain offline evaluation suites include precision/recall of fields, date/amount exactness,
 * entity-linking precision, false critical alert rate, and calibration by confidence band" / "Production
 * canaries compare new model output on sampled ... inputs before changing canonical extraction behavior."
 * Before this table existed, this codebase had zero extraction-quality regression testing — only unit
 * tests of code logic (schema-repair retry, dedup, etc), never "does the model still extract receipts
 * correctly." This is the persisted summary of one run of the golden-set eval harness (see
 * services/api/src/modules/intelligence/eval/run-golden-set-eval.ts) — one row per run, so a real quality
 * regression after a prompt/model change is a visible trend line, not a silently shipped surprise.
 */
export const modelEvalRuns = pgTable("model_eval_runs", {
  id: text("id").primaryKey(),
  // The model actually exercised by this run (may differ from modelRegistry.modelKey's CURRENT tier
  // assignment if the eval was run against a specific pinned model) — free text, not a FK, so a run against
  // a since-retired/renamed model stays readable.
  modelKey: text("model_key").notNull(),
  // A label for which version of the golden set + prompts this run exercised (e.g. "golden_set_v1") — lets
  // a later run against an expanded/edited golden set be told apart from this one in the history view.
  goldenSetVersion: text("golden_set_version").notNull(),
  totalCases: integer("total_cases").notNull(),
  passedCases: integer("passed_cases").notNull(),
  passRate: real("pass_rate").notNull(),
  // Per-schema breakdown: [{ schemaName, total, passed, passRate }, ...] — §39.2 "per-domain ... suites".
  bySchema: jsonb("by_schema").$type<Array<{ schemaName: string; total: number; passed: number; passRate: number }>>().notNull().default([]),
  // Individual field-level misses (capped by the harness before insert — see its own doc comment) so a
  // regression's exact shape is inspectable without re-running the eval: [{ caseId, schemaName, field,
  // expected, actual }, ...].
  fieldFailures: jsonb("field_failures").$type<Array<{ caseId: string; schemaName: string; field: string; expected: unknown; actual: unknown }>>().notNull().default([]),
  // Free text: "manual", an operator's email, or a CI job id — who/what triggered this run. Never a FK to
  // admin_users; this harness is meant to also run from an unattended scheduled job (see the runner
  // script's own doc comment), which has no admin session to attribute to.
  triggeredBy: text("triggered_by"),
  runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
});
