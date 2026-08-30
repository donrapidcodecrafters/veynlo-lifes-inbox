import { Inject, Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType, ZodTypeDef } from "zod";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";

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

const MODEL_BY_TIER = {
  cheap: "claude-haiku-4-5-20251001",
  reasoning: "claude-sonnet-5",
} as const;

/**
 * Per-million-token pricing in USD cents, keyed by the same model ids as `MODEL_BY_TIER`. Anthropic's
 * published pricing changes independently of this codebase — these are a point-in-time snapshot for cost
 * *observability* (admin model-health dashboard), not a billing-critical figure, so an occasional drift
 * against the live price list is an acceptable tradeoff against hardcoding an env-var indirection nobody
 * would remember to update either.
 */
const PRICE_CENTS_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 100, output: 500 },
  "claude-sonnet-5": { input: 300, output: 1500 },
};

export function estimateCostMinorUnits(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICE_CENTS_PER_MILLION_TOKENS[model];
  if (!price) return null;
  const cents = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  return Math.round(cents);
}

/**
 * §39.2 real per-extraction calibration — previously a hardcoded `0.82` for every single extraction
 * regardless of domain or quality, which meant nothing could ever cross `RISK_THRESHOLDS.highThreshold`
 * (0.85) OR drop below `reviewThreshold` (0.55): every AI-derived fact was permanently stuck in the
 * "needs_review" band, with no way for a user to tell a solid extraction from a shaky one.
 *
 * Anthropic doesn't return a calibrated probability, so this derives a real signal from what's actually
 * already present in every domain extraction schema (`ReceiptExtractionSchema`, `BillExtractionSchema`,
 * etc. — see `extraction-schemas.ts`): every one already has nullable fields the model is explicitly
 * instructed to leave `null` rather than guess, plus a `confidenceNotes: string` field it's prompted to
 * fill with anything ambiguous. Both are real per-extraction signals, not per-domain special-casing — this
 * function works generically across every schema's shape without knowing which fields exist.
 */
export function calibrateConfidence(data: unknown): number {
  if (typeof data !== "object" || data === null) return 0.75; // nothing to inspect — a neutral fallback, not the normal path
  const entries = Object.entries(data as Record<string, unknown>).filter(([key]) => key !== "confidenceNotes");
  const nullCount = entries.filter(([, value]) => value === null).length;
  const nullRatio = entries.length > 0 ? nullCount / entries.length : 0;
  const notes = (data as Record<string, unknown>).confidenceNotes;
  const hasUncertaintyNote = typeof notes === "string" && notes.trim().length > 0;

  let score = 0.95; // baseline for a clean, complete extraction with nothing flagged
  score -= nullRatio * 0.4; // every field the model couldn't confidently fill pulls this down
  if (hasUncertaintyNote) score -= 0.25; // the model itself flagged something ambiguous
  return Math.max(0.4, Math.min(0.97, score));
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
export class AnthropicExtractionService {
  private readonly logger = new Logger(AnthropicExtractionService.name);
  private client: Anthropic | null = null;
  /** (extractorName|model) -> extractor_versions.id, so a busy extractor doesn't insert a duplicate version row on every single call. */
  private readonly extractorVersionCache = new Map<string, string>();

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private getClient(): Anthropic | null {
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

    const model = MODEL_BY_TIER[request.model ?? "cheap"];
    const schemaForJson = request.schema as unknown as Parameters<typeof zodToJsonSchema>[0];
    const jsonSchema = zodToJsonSchema(schemaForJson, "schema").definitions?.schema ?? zodToJsonSchema(schemaForJson);
    const toolName = "emit_extraction";
    const hasPdf = Array.isArray(request.userContent) && request.userContent.some((block) => block.type === "document");

    const startedAt = new Date();
    const runId = request.sourceEventId ? await this.startRun(request.sourceEventId, request.extractorName, model) : null;

    try {
      const toolUseInput = hasPdf
        ? await this.callBeta(client, { model, request, jsonSchema, toolName })
        : await this.callStable(client, { model, request, jsonSchema, toolName });
      if (!toolUseInput) {
        await this.finishRun(runId, "failed", "Model returned no tool_use block", startedAt, null);
        return null;
      }

      const costMinorUnits = estimateCostMinorUnits(model, toolUseInput.usage.inputTokens, toolUseInput.usage.outputTokens);

      const parsed = request.schema.safeParse(toolUseInput.input);
      if (!parsed.success) {
        this.logger.error(`Schema validation failed for ${request.extractorName}: ${parsed.error.message}`);
        await this.finishRun(runId, "failed", `Schema validation failed: ${parsed.error.message}`, startedAt, costMinorUnits);
        return null; // §39.2: never let invalid structured output enter canonical data
      }

      await this.finishRun(runId, "success", null, startedAt, costMinorUnits);
      return {
        data: parsed.data,
        confidenceScore: calibrateConfidence(parsed.data),
        modelUsed: model,
        inputTokens: toolUseInput.usage.inputTokens,
        outputTokens: toolUseInput.usage.outputTokens,
      };
    } catch (err) {
      // A real API-level failure (network error, rate limit, etc.) — record it, then let it propagate
      // exactly as it did before this method tracked runs at all; callers' existing error handling is
      // unchanged, this only adds an observability side-effect on the way out. No token usage is available
      // here (the request may not have completed), so cost is left null rather than guessed.
      await this.finishRun(runId, "failed", String((err as Error)?.message ?? err), startedAt, null);
      throw err;
    }
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

  private async finishRun(
    runId: string | null,
    status: "success" | "failed",
    errorDetail: string | null,
    startedAt: Date,
    costMinorUnits: number | null,
  ): Promise<void> {
    if (!runId) return;
    const completedAt = new Date();
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
    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent as Anthropic.MessageParam["content"] }],
      tools: [{ name: toolName, description: request.toolDescription, input_schema: jsonSchema as Anthropic.Tool.InputSchema }],
      tool_choice: { type: "tool", name: toolName },
    });
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
    const response = await client.beta.messages.create({
      model,
      max_tokens: 2048,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent as Anthropic.Beta.Messages.BetaMessageParam["content"] }],
      tools: [
        { name: toolName, description: request.toolDescription, input_schema: jsonSchema as Anthropic.Beta.Messages.BetaTool.InputSchema },
      ],
      tool_choice: { type: "tool", name: toolName },
      betas: ["pdfs-2024-09-25"],
    });
    const toolUse = response.content.find((block): block is Anthropic.Beta.Messages.BetaToolUseBlock => block.type === "tool_use");
    if (!toolUse) {
      this.logger.error(`Model returned no tool_use block for ${request.extractorName}`);
      return null;
    }
    return { input: toolUse.input, usage: { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens } };
  }
}
