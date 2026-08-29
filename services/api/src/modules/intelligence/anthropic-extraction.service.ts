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
        await this.finishRun(runId, "failed", "Model returned no tool_use block", startedAt);
        return null;
      }

      const parsed = request.schema.safeParse(toolUseInput.input);
      if (!parsed.success) {
        this.logger.error(`Schema validation failed for ${request.extractorName}: ${parsed.error.message}`);
        await this.finishRun(runId, "failed", `Schema validation failed: ${parsed.error.message}`, startedAt);
        return null; // §39.2: never let invalid structured output enter canonical data
      }

      await this.finishRun(runId, "success", null, startedAt);
      return {
        data: parsed.data,
        confidenceScore: 0.82, // conservative default until per-domain calibration evaluations are wired (§39.2)
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

  private async finishRun(runId: string | null, status: "success" | "failed", errorDetail: string | null, startedAt: Date): Promise<void> {
    if (!runId) return;
    const completedAt = new Date();
    await this.db
      .update(schema.extractionRuns)
      .set({ status, errorDetail, latencyMs: completedAt.getTime() - startedAt.getTime(), completedAt })
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
