import { z } from "zod";

/**
 * Provenance is mandatory on every machine-derived fact (spec "Evidence
 * before assertion" / AI-001). UI-facing confidence never shows a raw
 * probability — it maps through ConfidenceBand — but the calibration
 * pipeline needs the float for evaluation.
 */
export const ConfidenceBandSchema = z.enum([
  "verified", // user-confirmed, or deterministic parser at max trust
  "high",
  "needs_review",
  "conflicting",
  "approximate",
]);
export type ConfidenceBand = z.infer<typeof ConfidenceBandSchema>;

export const VerificationStateSchema = z.enum([
  "unverified",
  "user_confirmed",
  "user_corrected",
  "superseded",
]);
export type VerificationState = z.infer<typeof VerificationStateSchema>;

export const ExtractionMethodSchema = z.enum([
  "deterministic_parser", // sender/template rule, regex, schema.org, JSON-LD
  "ai_structured_extraction",
  "user_manual_entry",
  "user_capture_ocr",
]);
export type ExtractionMethod = z.infer<typeof ExtractionMethodSchema>;

/** A pointer back to the exact evidence a fact/entity was derived from. */
export const EvidenceRefSchema = z.object({
  id: z.string(),
  sourceEventId: z.string(),
  /** e.g. "email:body", "document:page:3:region", "transaction:field:amount" */
  locator: z.string(),
  excerpt: z.string().nullable(),
  capturedAt: z.string().datetime(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ProvenanceSchema = z.object({
  extractionMethod: ExtractionMethodSchema,
  extractorVersion: z.string(),
  confidenceScore: z.number().min(0).max(1),
  confidenceBand: ConfidenceBandSchema,
  verification: VerificationStateSchema,
  evidence: z.array(EvidenceRefSchema).min(1),
  extractedAt: z.string().datetime(),
  supersedesFactId: z.string().nullable(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Maps a raw model confidence score to a UI-safe band given a per-domain risk
 * threshold. Never expose the raw float in end-user UI (spec AI-002).
 */
export function confidenceToBand(score: number, opts: { reviewThreshold: number; highThreshold: number }): ConfidenceBand {
  if (score >= opts.highThreshold) return "high";
  if (score >= opts.reviewThreshold) return "needs_review";
  return "approximate";
}
