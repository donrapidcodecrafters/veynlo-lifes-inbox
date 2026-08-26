import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ZodType, ZodTypeDef } from "zod";
import { loadEnv } from "../../config/env";

export interface StructuredExtractionRequest<T> {
  /** e.g. "receipt_extraction_v1" — persisted as the extractor version for provenance (§39.2). */
  extractorName: string;
  systemPrompt: string;
  /** Plain text, or real multi-modal content blocks (image/document) for OCR-style extraction — never a text description standing in for bytes the model hasn't actually seen. */
  userContent: string | Anthropic.MessageParam["content"];
  /** Input type intentionally left as `any` — pinning it to `T` makes TS infer optional/default fields incorrectly at call sites. */
  schema: ZodType<T, ZodTypeDef, any>;
  toolDescription: string;
  /** Cheap/fast tier by default (§41.4 "larger reasoning models are not the default receipt parser"). */
  model?: "cheap" | "reasoning";
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

    const response = await client.messages.create({
      model,
      max_tokens: 2048,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userContent }],
      tools: [
        {
          name: toolName,
          description: request.toolDescription,
          input_schema: jsonSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: "tool", name: toolName },
    });

    const toolUse = response.content.find((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
    if (!toolUse) {
      this.logger.error(`Model returned no tool_use block for ${request.extractorName}`);
      return null;
    }

    const parsed = request.schema.safeParse(toolUse.input);
    if (!parsed.success) {
      this.logger.error(`Schema validation failed for ${request.extractorName}: ${parsed.error.message}`);
      return null; // §39.2: never let invalid structured output enter canonical data
    }

    return {
      data: parsed.data,
      confidenceScore: 0.82, // conservative default until per-domain calibration evaluations are wired (§39.2)
      modelUsed: model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
