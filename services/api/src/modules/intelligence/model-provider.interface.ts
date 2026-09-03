import type { StructuredExtractionRequest, StructuredExtractionResult } from "./anthropic-extraction.service";

/**
 * §2 "The AI layer is replaceable. No domain logic should require one model vendor forever" / §19
 * "internal model-router package/service with adapters for multiple providers." `AnthropicExtractionService`
 * is the only implementation today — a hard dependency on the Anthropic SDK with no router. This interface
 * is the contract every call site (ingestion's domain classifiers/extractors, document OCR, Ask synthesis,
 * admin model-health reporting) actually depends on; a future `ModelRouterService` selecting between
 * Anthropic/OpenAI/Bedrock per request would implement this same shape without touching any call site.
 * Deliberately not attempting the full router/multi-provider implementation here — that's a real feature
 * (provider selection policy, per-provider adapters, cost comparison), not a mechanical interface
 * extraction, and there is exactly one provider to route to today.
 */
export interface ModelProvider {
  isConfigured(): boolean;
  extractStructured<T>(request: StructuredExtractionRequest<T>): Promise<StructuredExtractionResult<T> | null>;
}

/** See queue-producer.interface.ts's identical doc comment for why an explicit token is needed. */
export const MODEL_PROVIDER = Symbol("MODEL_PROVIDER");
