import type { ModelProvider } from "./model-provider.interface";
import type { StructuredExtractionRequest, StructuredExtractionResult } from "./anthropic-extraction.service";

/**
 * Deterministic `ModelProvider` test double. Before this existed, everything downstream of AI extraction
 * (domain classification, structured extraction, dedup logic, Ask) had zero automated test coverage —
 * every prior verification of these paths was a one-off manual curl/psql check against a real (or
 * deliberately unconfigured) Anthropic API, never a repeatable test. Queue a canned result per
 * `extractorName` with `enqueue()` (consumed FIFO, one per call to that extractor); an unqueued
 * extractorName returns `null`, matching a real provider's "couldn't extract" response — never throws.
 */
export class FakeModelProvider implements ModelProvider {
  private readonly queues = new Map<string, unknown[]>();
  configured = true;
  readonly calls: string[] = [];
  // PERS-005 "AI tone/verbosity" test support — records every request's full shape (notably
  // `systemPrompt`) so a test can assert what prompt a caller actually built, not just that some call
  // happened. Additive only; nothing pre-existing reads this.
  readonly requests: StructuredExtractionRequest<unknown>[] = [];

  isConfigured(): boolean {
    return this.configured;
  }

  enqueue<T>(extractorName: string, result: StructuredExtractionResult<T>): void {
    const queue = this.queues.get(extractorName) ?? [];
    queue.push(result);
    this.queues.set(extractorName, queue);
  }

  async extractStructured<T>(request: StructuredExtractionRequest<T>): Promise<StructuredExtractionResult<T> | null> {
    this.calls.push(request.extractorName);
    this.requests.push(request as StructuredExtractionRequest<unknown>);
    const queue = this.queues.get(request.extractorName);
    if (!queue || queue.length === 0) return null;
    return queue.shift() as StructuredExtractionResult<T>;
  }
}

/** Convenience for a typical canned result — most tests only care about `data`. */
export function fakeExtraction<T>(data: T, confidenceScore = 0.82): StructuredExtractionResult<T> {
  return { data, confidenceScore, modelUsed: "fake-model", inputTokens: 0, outputTokens: 0 };
}
