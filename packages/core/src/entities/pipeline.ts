import { z } from "zod";

/** §39.1 — the eight-stage layered intelligence pipeline every source event passes through. */
export const PipelineStageSchema = z.enum([
  "deterministic_prefilter",
  "relevance_classifier",
  "domain_classifier",
  "structured_extraction",
  "entity_resolution",
  "rules_state_logic",
  "reasoning_ask",
  "agent_planning",
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const DomainClassificationSchema = z.enum([
  "receipt",
  "shipment",
  "bill",
  "subscription",
  "calendar_event",
  "travel",
  "warranty",
  "identity_document",
  "school",
  "home",
  "vehicle",
  "saved_item",
  "irrelevant",
]);
export type DomainClassification = z.infer<typeof DomainClassificationSchema>;

/** Persisted per model/prompt/parser so a fact can always be explained or reprocessed (§39.2). */
export const ExtractorVersionSchema = z.object({
  id: z.string(),
  stage: PipelineStageSchema,
  name: z.string(), // e.g. "amazon-order-parser", "receipt-structured-extraction"
  version: z.string(),
  modelKey: z.string().nullable(), // null for deterministic parsers
  createdAt: z.string().datetime(),
  deprecatedAt: z.string().datetime().nullable(),
});
export type ExtractorVersion = z.infer<typeof ExtractorVersionSchema>;

export const ExtractionRunStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed_schema_invalid",
  "failed_provider_error",
  "skipped_relevance_gate",
  "skipped_budget",
]);
export type ExtractionRunStatus = z.infer<typeof ExtractionRunStatusSchema>;

export const ExtractionRunSchema = z.object({
  id: z.string(),
  sourceEventId: z.string(),
  stage: PipelineStageSchema,
  extractorVersionId: z.string(),
  status: ExtractionRunStatusSchema,
  costMinorUnits: z.number().int().nullable(),
  latencyMs: z.number().int().nullable(),
  outputJson: z.unknown().nullable(),
  errorDetail: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
});
export type ExtractionRun = z.infer<typeof ExtractionRunSchema>;

/** Per-domain risk policy mapping confidence + impact to an acceptance action (§AI-002). */
export const RiskPolicySchema = z.object({
  domain: DomainClassificationSchema,
  field: z.string(),
  autoAcceptThreshold: z.number().min(0).max(1),
  reviewThreshold: z.number().min(0).max(1),
  policyVersion: z.string(),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;
