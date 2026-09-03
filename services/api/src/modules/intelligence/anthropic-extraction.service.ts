import { Inject, Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType, ZodTypeDef } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { summarizeZodError } from "../../common/safe-error-log";
import type { ModelProvider } from "./model-provider.interface";
import { computeExtractionConfidence } from "./extraction-confidence";

export type ExtractionContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export interface StructuredExtractionRequest<T> {
  /** e.g. "receipt_extraction_v1" — persisted as the extractor version for provenance (§39.2). */
  extractorName: string;
  systemPrompt: string;
  /** Plain text, or real multi-modal content blocks (image/document) for OCR-style extraction — never a text description standing in for bytes the model hasn't actually seen. A `document` block routes through Anthropic's beta PDF-input surface (see below); everything else uses the stable Messages API. */
  userContent: string | ExtractionContentBlock[];
  /** Input type intentionally left as `any` — pinning it to `T` makes TS infer optional/default fields incorrectly at call sites. */
  schema: ZodType<T, ZodTypeDef, any>;
  toolDescription: string;
  /** Cheap/fast tier by default (§41.4 "larger reasoning models are not the default receipt parser"). */
  model?: "cheap" | "reasoning";
  /** When present, this call is tracked in `extraction_runs` for admin "model health" observability
   * (success/failure rate, latency, error patterns) — see `IngestionService`'s call sites, all of which
   * have a real source event to attribute the run to. Omitted by documents.service.ts's OCR calls and
   * search.service.ts's Ask synthesis call, which have no `source_events` row to reference (a document is
   * user-uploaded, not connector-derived, and Ask synthesizes across many source events at once) — those
   * stay uninstrumented rather than force a schema change to make the FK nullable; a real gap, not a
   * silent one, tracked as a follow-up. */
  sourceEventId?: string;
}

export interface StructuredExtractionResult<T> {
  data: T;
  /** Anthropic doesn't emit a calibrated probability; this is a coarse heuristic band, refined by §AI-002 risk policy downstream. */
  confidenceScore: number;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * §39.2 "Model routing, versioning and evaluation" — the routing DECISION (which tier a call needs) is
 * still exactly this: real code, chosen per call site (`request.model ?? "cheap"`). What used to be
 * hardcoded here too was the concrete MODEL BEHIND each tier — this object is now only the safety-net
 * default `resolveModelForTier` below falls back to when `model_registry` (packages/db/src/schema/
 * pipeline.ts) has no active (non-sunset) row for a tier — an unseeded environment, or every model for a
 * tier having been sunset with no replacement seeded yet. Keeping this as a real fallback rather than
 * throwing means a fresh/misconfigured registry degrades to "identical behavior to before the registry
 * existed," never a hard outage.
 */
const DEFAULT_MODEL_BY_TIER = {
  cheap: "claude-haiku-4-5-20251001",
  reasoning: "claude-sonnet-5",
} as const;

// §47.4 "AI/infrastructure unit-cost controls" / §39.2 "tokens/cost" telemetry — Anthropic's published
// first-party API pricing (USD per MILLION tokens) for exactly the two models MODEL_BY_TIER above can
// select. THIS TABLE IS A POINT-IN-TIME SNAPSHOT (current as of 2026-08) — if Anthropic changes pricing for
// either model, or a new tier/model is added to MODEL_BY_TIER, this must be updated too or every
// extraction_runs.costMinorUnits written after that silently under/over-reports real spend forever. Not
// read from any live pricing API — Anthropic doesn't expose one — so this is the one place that assumption
// lives, deliberately named and commented rather than a bare number buried in a cost formula.
const MODEL_PRICING_USD_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 1.0, output: 5.0 },
  "claude-sonnet-5": { input: 2.0, output: 10.0 },
};

/**
 * Real cost in USD minor units (cents) — same "minor units" convention as every other money column in this
 * schema (e.g. `bills.amountDueMinorUnits`), so admin/reporting code that sums `costMinorUnits` never needs
 * a special case for AI cost. Returns `null` for a model not in the pricing table above (an unpriced/unknown
 * model, e.g. a future tier added to MODEL_BY_TIER without a matching pricing update) rather than fabricating
 * a number — `finishRun` leaves `costMinorUnits` unset in that case, a visible gap rather than a silently
 * wrong one. Rounds to the nearest cent; a single cheap call can genuinely round to 0, which is honest, not
 * a bug — real per-run AI cost is often a small fraction of a cent.
 */
export function computeCostMinorUnits(model: string, inputTokens: number, outputTokens: number): number | null {
  const pricing = MODEL_PRICING_USD_PER_MILLION_TOKENS[model];
  if (!pricing) return null;
  const dollars = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return Math.round(dollars * 100);
}

// §28.13 "excessive OCR work" / general resource-consumption bound — without this, a slow/hanging
// upstream request could tie up a worker/request indefinitely. Generous enough for a page-heavy PDF
// transcription (the slowest real call this service makes) without being effectively unbounded.
const MODEL_CALL_TIMEOUT_MS = 2 * 60 * 1000;

// §AI-003 "prompt-injection and untrusted-source defense" analytics gap — every extraction/classification
// prompt already carries a real, structural defense (EMAIL_INJECTION_DEFENSE_PREFIX/
// SHARE_MESSAGE_INJECTION_DEFENSE_PREFIX in ingestion.service.ts, plus this service's own schema-constrained
// `tool_choice`), but nothing ever recorded whether an actual injection ATTEMPT occurred, so there was no
// way to measure how often the defense is even tested, let alone whether it held. This is a coarse,
// deliberately imperfect post-hoc heuristic over the raw untrusted content fed into a call — detection and
// logging for awareness/analytics (`prompt_security_events`, previously a real table with zero writers
// anywhere), NOT a new blocking mechanism; the schema-constrained tool use + Zod validation remains the
// actual defense; a false positive here only adds a log row, it never rejects a legitimate extraction.
const PROMPT_INJECTION_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: "ignore_previous_instructions", pattern: /ignore\s+(all\s+|the\s+)?(previous|prior|above)\s+instructions?/i },
  { label: "disregard_above", pattern: /disregard\s+(all\s+|the\s+)?(above|previous|prior)/i },
  { label: "forget_instructions", pattern: /forget\s+(all\s+|your\s+|previous\s+)?instructions?/i },
  { label: "new_instructions", pattern: /new\s+instructions?\s*:/i },
  { label: "role_override", pattern: /you\s+are\s+now\s+(a|an|the)?\s*\S+/i },
  { label: "system_prompt_marker", pattern: /(^|\n)\s*system\s*:/i },
  { label: "reveal_system_prompt", pattern: /reveal\s+(your\s+)?(system\s+)?prompt/i },
  { label: "do_not_follow_rules", pattern: /do\s+not\s+follow\s+(the\s+)?(rules|instructions|schema)/i },
  { label: "override_directive", pattern: /this\s+is\s+(a|an)\s+(urgent\s+)?(override|admin)\s+(instruction|command)/i },
  { label: "actual_value_is", pattern: /the\s+(real|actual|true)\s+(amount|total|date|value)\s+is\s+(actually\s+)?\S/i },
];

/** Scans only real text — image/document (base64 OCR/PDF) blocks carry no inspectable text at this layer,
 * so they're skipped rather than treated as a false "no injection detected." */
function extractTextForInjectionScan(userContent: string | ExtractionContentBlock[]): string {
  if (typeof userContent === "string") return userContent;
  return userContent
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function detectPromptInjectionAttempt(text: string): string | null {
  for (const { label, pattern } of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(text)) return label;
  }
  return null;
}

/**
 * Thin wrapper around the Anthropic API used for stages 2-3 of the pipeline
 * (domain classification + structured extraction, §39.1) and stage 6
 * (Ask synthesis). Every call is schema-constrained tool use — free-form
 * text is never parsed as if it were structured truth (§AI-001/§39.2:
 * "invalid output retries through a constrained repair path... never
 * silently enters canonical data").
 */
@Injectable()
export class AnthropicExtractionService implements ModelProvider {
  private readonly logger = new Logger(AnthropicExtractionService.name);
  private client: Anthropic | null = null;
  /** (extractorName|model) -> extractor_versions.id, so a busy extractor doesn't insert a duplicate version row on every single call. */
  private readonly extractorVersionCache = new Map<string, string>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  // `protected`, not `private`, purely so a test subclass can override it with a fake Anthropic-shaped
  // client (see anthropic-extraction.service.test.ts) — real, deterministic coverage of the schema-repair
  // retry (§AI-003/§39.2) and prompt-injection detection/logging (§AI-003) paths without a real network
  // call to Anthropic on every test run. No behavior change for the real app, which never subclasses this.
  protected getClient(): Anthropic | null {
    const apiKey = loadEnv().ANTHROPIC_API_KEY;
    if (!apiKey) return null;
    if (!this.client) this.client = new Anthropic({ apiKey });
    return this.client;
  }

  isConfigured(): boolean {
    return Boolean(loadEnv().ANTHROPIC_API_KEY);
  }

  async extractStructured<T>(request: StructuredExtractionRequest<T>): Promise<StructuredExtractionResult<T> | null> {
    const client = this.getClient();
    if (!client) {
      this.logger.warn(`ANTHROPIC_API_KEY not configured — skipping AI extraction for ${request.extractorName}`);
      return null;
    }

    const model = await this.resolveModelForTier(request.model ?? "cheap");
    const schemaForJson = request.schema as unknown as Parameters<typeof zodToJsonSchema>[0];
    const jsonSchema = zodToJsonSchema(schemaForJson, "schema").definitions?.schema ?? zodToJsonSchema(schemaForJson);
    const toolName = "emit_extraction";
    const hasPdf = Array.isArray(request.userContent) && request.userContent.some((block) => block.type === "document");

    const startedAt = new Date();
    const runId = request.sourceEventId ? await this.startRun(request.sourceEventId, request.extractorName, model) : null;

    // §AI-003 detection-and-logging — computed once up front from the raw untrusted content this call was
    // actually given, regardless of how the call itself turns out.
    const matchedPattern = detectPromptInjectionAttempt(extractTextForInjectionScan(request.userContent));

    try {
      const toolUseInput = hasPdf
        ? await this.callBeta(client, { model, request, jsonSchema, toolName })
        : await this.callStable(client, { model, request, jsonSchema, toolName });
      if (!toolUseInput) {
        // No `usage` here — callStable/callBeta only surface token counts alongside an actual tool_use
        // block (see their own return shape); a model response with none never had a usable figure captured
        // for this call. A real, documented gap (this run's costMinorUnits stays null) rather than a
        // fabricated zero — see finishRun's own doc comment.
        await this.finishRun(runId, "failed", "Model returned no tool_use block", startedAt);
        await this.logPromptSecurityEventIfMatched(request, matchedPattern, false);
        return null;
      }

      const parsed = request.schema.safeParse(toolUseInput.input);
      if (!parsed.success) {
        // §28 "No raw ... documents ... in normal application logs" — toolUseInput.input is the model's
        // extraction of the source document/email (receipt text, health-appointment detail, etc.); a raw
        // `error.message`/`error.issues[].message` from zod embeds the actual offending value for several
        // issue codes (invalid_enum_value, invalid_literal, ...), which would republish extracted document
        // content into logs. Path + issue code is enough to diagnose a schema mismatch. `finishRun`'s
        // errorDetail column is a separate, already-encrypted `encryptedText` (packages/db/src/schema/
        // pipeline.ts) so it can safely keep the fuller message for in-app debugging.
        const summary = summarizeZodError(parsed.error);
        this.logger.error(`Schema validation failed for ${request.extractorName}: ${summary}`);

        // §AI-003/§39.2 "invalid output retries through a constrained repair path" — one real, bounded
        // retry: re-issue the SAME call with the actual Zod error appended to the system prompt, so the
        // model has something concrete to correct. No alternate-model fallback, no loop — if the repair
        // attempt also fails to validate (or itself errors), this falls through to the exact same "return
        // null, never let invalid structured output enter canonical data" behavior as before this existed.
        const repaired = await this.attemptSchemaRepair({ model, request, jsonSchema, toolName, hasPdf, priorErrorSummary: summary });
        if (repaired) {
          // §47.4/§39.2 cost — TWO real, billable API calls happened for this one extraction_runs row (the
          // original invalid attempt, then the repair retry), so the cost recorded here is their SUM, not
          // just the repair call's own usage — undercounting by dropping the first call's tokens would
          // silently understate this run's real spend.
          const totalUsage = {
            model,
            inputTokens: toolUseInput.usage.inputTokens + repaired.usage.inputTokens,
            outputTokens: toolUseInput.usage.outputTokens + repaired.usage.outputTokens,
          };
          await this.finishRun(runId, "success", null, startedAt, totalUsage);
          await this.logPromptSecurityEventIfMatched(request, matchedPattern, true);
          return {
            data: repaired.data,
            confidenceScore: computeExtractionConfidence(repaired.data as Record<string, unknown>),
            modelUsed: model,
            inputTokens: totalUsage.inputTokens,
            outputTokens: totalUsage.outputTokens,
          };
        }

        // The original (invalid-output) call still cost real money even though the repair attempt gave up —
        // its usage is the only real figure available for this run, so that's what gets billed.
        await this.finishRun(runId, "failed", `Schema validation failed: ${parsed.error.message}`, startedAt, {
          model,
          inputTokens: toolUseInput.usage.inputTokens,
          outputTokens: toolUseInput.usage.outputTokens,
        });
        await this.logPromptSecurityEventIfMatched(request, matchedPattern, false);
        return null; // §39.2: never let invalid structured output enter canonical data
      }

      await this.finishRun(runId, "success", null, startedAt, { model, inputTokens: toolUseInput.usage.inputTokens, outputTokens: toolUseInput.usage.outputTokens });
      await this.logPromptSecurityEventIfMatched(request, matchedPattern, true);
      return {
        data: parsed.data,
        confidenceScore: computeExtractionConfidence(parsed.data as Record<string, unknown>),
        modelUsed: model,
        inputTokens: toolUseInput.usage.inputTokens,
        outputTokens: toolUseInput.usage.outputTokens,
      };
    } catch (err) {
      // A real API-level failure (network error, rate limit, etc.) — record it, then let it propagate
      // exactly as it did before this method tracked runs at all; callers' existing error handling is
      // unchanged, this only adds an observability side-effect on the way out.
      await this.finishRun(runId, "failed", String((err as Error)?.message ?? err), startedAt);
      throw err;
    }
  }

  /** One-shot schema-repair retry (§AI-003) — same tool-use call, same schema, with the prior Zod error
   * folded into the system prompt. Any failure here (network error, still-invalid output, no tool_use
   * block) is swallowed and treated as "repair failed" rather than propagated, matching "if the retry also
   * fails, return null exactly as today." */
  private async attemptSchemaRepair<T>(args: {
    model: string;
    request: StructuredExtractionRequest<T>;
    jsonSchema: unknown;
    toolName: string;
    hasPdf: boolean;
    priorErrorSummary: string;
  }): Promise<{ data: T; usage: { inputTokens: number; outputTokens: number } } | null> {
    const { model, request, jsonSchema, toolName, hasPdf, priorErrorSummary } = args;
    const repairRequest: StructuredExtractionRequest<T> = {
      ...request,
      systemPrompt:
        `${request.systemPrompt}\n\nYour previous response failed schema validation with these errors: ` +
        `${priorErrorSummary}. Correct your response so it satisfies the schema exactly — every required ` +
        `field present with the correct type, no extra fields.`,
    };
    try {
      const client = this.getClient();
      if (!client) return null;
      const toolUseInput = hasPdf
        ? await this.callBeta(client, { model, request: repairRequest, jsonSchema, toolName })
        : await this.callStable(client, { model, request: repairRequest, jsonSchema, toolName });
      if (!toolUseInput) return null;
      const parsed = request.schema.safeParse(toolUseInput.input);
      if (!parsed.success) {
        this.logger.error(`Schema-repair retry also failed validation for ${request.extractorName}: ${summarizeZodError(parsed.error)}`);
        return null;
      }
      return { data: parsed.data, usage: toolUseInput.usage };
    } catch (err) {
      this.logger.warn(`Schema-repair retry errored for ${request.extractorName}: ${String((err as Error)?.message ?? err)}`);
      return null;
    }
  }

  /** §AI-003 detection-and-logging — non-fatal by design: a failure to write the log row must never affect
   * the extraction result itself (same "observability side-effect only" posture as finishRun's callers). */
  private async logPromptSecurityEventIfMatched(request: StructuredExtractionRequest<unknown>, matchedPattern: string | null, schemaValid: boolean): Promise<void> {
    if (!matchedPattern) return;
    try {
      await this.db.insert(schema.promptSecurityEvents).values({
        id: generateId("promptSecurityEvent"),
        sourceEventId: request.sourceEventId ?? null,
        kind: "instruction_like_content_blocked",
        detail: JSON.stringify({ extractorName: request.extractorName, matchedPattern, schemaValid }),
      });
    } catch (err) {
      this.logger.warn(`Failed to record prompt-security event for ${request.extractorName}: ${String((err as Error)?.message ?? err)}`);
    }
  }

  /**
   * §39.2 "Model routing, versioning and evaluation" — resolves which concrete model currently answers a
   * routing tier by reading `model_registry` (packages/db/src/schema/pipeline.ts) instead of a hardcoded
   * map. Excludes any row with `sunsetAt` set (the "global kill switch ... without a client release" this
   * chapter calls for) and, among the remaining candidates, prefers the most recently created — so
   * inserting a new row for a tier (a model swap) takes effect immediately without touching the old row.
   * Falls back to `DEFAULT_MODEL_BY_TIER` when the registry has no active row for this tier at all (an
   * unseeded environment, or every row sunset with no replacement yet) — see that constant's own doc
   * comment for why a fallback beats throwing here.
   *
   * Deliberately a plain per-call query, no in-memory cache — same "read the current row every time"
   * posture as `RiskPolicyService.resolveThresholds` and `FeatureFlagsService.isEnabled`, both of which
   * exist specifically so an admin data change (a policy retune, a flag flip, and now a model swap/kill)
   * takes effect on the very next call, not after some cache TTL or a redeploy.
   */
  private async resolveModelForTier(tier: "cheap" | "reasoning"): Promise<string> {
    const [row] = await this.db
      .select({ modelKey: schema.modelRegistry.modelKey })
      .from(schema.modelRegistry)
      .where(and(eq(schema.modelRegistry.tier, tier), isNull(schema.modelRegistry.sunsetAt)))
      .orderBy(desc(schema.modelRegistry.createdAt))
      .limit(1);
    return row?.modelKey ?? DEFAULT_MODEL_BY_TIER[tier];
  }

  /** Reuses one extractor_versions row per (name, model) pair rather than inserting a fresh one on every call. */
  private async getOrCreateExtractorVersionId(extractorName: string, model: string): Promise<string> {
    const cacheKey = `${extractorName}|${model}`;
    const cached = this.extractorVersionCache.get(cacheKey);
    if (cached) return cached;

    const [existing] = await this.db
      .select({ id: schema.extractorVersions.id })
      .from(schema.extractorVersions)
      .where(and(eq(schema.extractorVersions.name, extractorName), eq(schema.extractorVersions.modelKey, model)))
      .limit(1);
    if (existing) {
      this.extractorVersionCache.set(cacheKey, existing.id);
      return existing.id;
    }

    const id = generateId("extractorVersion");
    await this.db.insert(schema.extractorVersions).values({ id, stage: "extraction", name: extractorName, version: "1", modelKey: model });
    this.extractorVersionCache.set(cacheKey, id);
    return id;
  }

  private async startRun(sourceEventId: string, extractorName: string, model: string): Promise<string> {
    const extractorVersionId = await this.getOrCreateExtractorVersionId(extractorName, model);
    const id = generateId("extractionRun");
    await this.db.insert(schema.extractionRuns).values({ id, sourceEventId, stage: "extraction", extractorVersionId, status: "running" });
    return id;
  }

  /**
   * §47.4/§39.2 "tokens/cost" — `usage`, when supplied, is the real (possibly summed-across-retry, see
   * `attemptSchemaRepair`'s call site) token count for whatever API call(s) this run actually made;
   * `computeCostMinorUnits` turns that into a real dollar figure rather than leaving `costMinorUnits`
   * permanently null the way it was before this existed. Omitted (not just token-less) for the "no tool_use
   * block at all" and network-error paths below, where no usage figure was ever captured — see those call
   * sites' own comments for why that's an accepted, documented gap rather than a fabricated zero.
   */
  private async finishRun(
    runId: string | null,
    status: "success" | "failed",
    errorDetail: string | null,
    startedAt: Date,
    usage?: { model: string; inputTokens: number; outputTokens: number },
  ): Promise<void> {
    if (!runId) return;
    const completedAt = new Date();
    const costMinorUnits = usage ? computeCostMinorUnits(usage.model, usage.inputTokens, usage.outputTokens) : null;
    await this.db
      .update(schema.extractionRuns)
      .set({ status, errorDetail, latencyMs: completedAt.getTime() - startedAt.getTime(), completedAt, costMinorUnits })
      .where(eq(schema.extractionRuns.id, runId));
  }

  private async callStable<T>(
    client: Anthropic,
    args: { model: string; request: StructuredExtractionRequest<T>; jsonSchema: unknown; toolName: string },
  ) {
    const { model, request, jsonSchema, toolName } = args;
    const response = await client.messages.create(
      {
        model,
        max_tokens: 2048,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userContent as Anthropic.MessageParam["content"] }],
        tools: [{ name: toolName, description: request.toolDescription, input_schema: jsonSchema as Anthropic.Tool.InputSchema }],
        tool_choice: { type: "tool", name: toolName },
      },
      { timeout: MODEL_CALL_TIMEOUT_MS },
    );
    const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (!toolUse) {
      this.logger.error(`Model returned no tool_use block for ${request.extractorName}`);
      return null;
    }
    return { input: toolUse.input, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
  }

  /**
   * PDF input goes through Anthropic's beta document-input surface
   * (`client.beta.messages`, `betas: ["pdfs-2024-09-25"]`) — this is the
   * same schema-constrained tool-use pattern as `callStable`, just against
   * the beta API surface, which is where `type: "document"` content
   * blocks are supported in this SDK version (§ROADMAP "PDF OCR").
   */
  private async callBeta<T>(
    client: Anthropic,
    args: { model: string; request: StructuredExtractionRequest<T>; jsonSchema: unknown; toolName: string },
  ) {
    const { model, request, jsonSchema, toolName } = args;
    const response = await client.beta.messages.create(
      {
        model,
        max_tokens: 2048,
        system: request.systemPrompt,
        messages: [{ role: "user", content: request.userContent as Anthropic.Beta.Messages.BetaMessageParam["content"] }],
        tools: [
          { name: toolName, description: request.toolDescription, input_schema: jsonSchema as Anthropic.Beta.Messages.BetaTool.InputSchema },
        ],
        tool_choice: { type: "tool", name: toolName },
        betas: ["pdfs-2024-09-25"],
      },
      { timeout: MODEL_CALL_TIMEOUT_MS },
    );
    const toolUse = response.content.find((block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === "tool_use");
    if (!toolUse) {
      this.logger.error(`Model returned no tool_use block for ${request.extractorName}`);
      return null;
    }
    return { input: toolUse.input, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
  }
}
