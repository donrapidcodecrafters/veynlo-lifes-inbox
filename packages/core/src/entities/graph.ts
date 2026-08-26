import { z } from "zod";
import { ProvenanceSchema } from "./provenance";
import { SensitivityTierSchema, VisibilitySchema } from "../permissions/sensitivity";

/** §11.1 — universal capture contract. Every ingestion path starts here, immutably. */
export const SourceEventKindSchema = z.enum([
  "email_message",
  "calendar_event_raw",
  "financial_transaction",
  "document_upload",
  "camera_scan",
  "share_capture",
  "browser_capture",
  "voice_note",
  "manual_entry",
]);
export type SourceEventKind = z.infer<typeof SourceEventKindSchema>;

export const SourceEventProcessingStateSchema = z.enum([
  "queued",
  "uploading",
  "scanning",
  "understanding",
  "needs_review",
  "filed",
  "duplicate",
  "failed_retryable",
  "failed_user_action",
  "quarantined",
]);
export type SourceEventProcessingState = z.infer<typeof SourceEventProcessingStateSchema>;

export const SourceEventSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  connectionId: z.string().nullable(),
  kind: SourceEventKindSchema,
  providerItemId: z.string().nullable(), // provider-native ID for idempotent dedupe
  contentHash: z.string(),
  occurredAt: z.string().datetime(),
  receivedAt: z.string().datetime(),
  rawContentRef: z.string().nullable(), // pointer into object storage; never inline
  sensitivity: SensitivityTierSchema,
  processingState: SourceEventProcessingStateSchema,
  idempotencyKey: z.string(),
  createdAt: z.string().datetime(),
});
export type SourceEvent = z.infer<typeof SourceEventSchema>;

/** Canonical entity types the knowledge graph can hold (§39.3, §44.1-44.2). Extensible without touching core plumbing. */
export const CanonicalEntityTypeSchema = z.enum([
  "person",
  "organization",
  "place",
  "merchant",
  "purchase",
  "product",
  "asset",
  "vehicle",
  "property",
  "subscription",
  "bill",
  "trip",
  "reservation",
  "document",
  "pet",
  "saved_item",
]);
export type CanonicalEntityType = z.infer<typeof CanonicalEntityTypeSchema>;

export const CanonicalEntitySchema = z.object({
  id: z.string(),
  type: CanonicalEntityTypeSchema,
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  displayLabel: z.string(),
  sensitivity: SensitivityTierSchema,
  visibility: VisibilitySchema,
  aliases: z.array(z.string()).default([]),
  lifecycleState: z.string(), // domain-specific state machine value, see domain modules
  mergedIntoEntityId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type CanonicalEntity = z.infer<typeof CanonicalEntitySchema>;

/** §40.2 — merges are reversible; lineage is preserved forever. */
export const EntityMergeLineageSchema = z.object({
  id: z.string(),
  survivingEntityId: z.string(),
  mergedEntityId: z.string(),
  reason: z.string(),
  algorithmVersion: z.string(),
  confidenceScore: z.number().min(0).max(1),
  actorUserId: z.string().nullable(), // null when automatic
  mergedAt: z.string().datetime(),
  unmergedAt: z.string().datetime().nullable(),
});
export type EntityMergeLineage = z.infer<typeof EntityMergeLineageSchema>;

export const RelationshipTypeSchema = z.enum([
  "owns",
  "lives_at",
  "paid_by",
  "insured_by",
  "purchased_from",
  "installed_at",
  "serviced_by",
  "applies_to",
  "traveler_on",
  "parent_of",
  "caregiver_for",
  "evidence_for",
  "supersedes",
  "contains",
  "has_document",
  "has_warranty",
]);
export type RelationshipType = z.infer<typeof RelationshipTypeSchema>;

export const RelationshipSchema = z.object({
  id: z.string(),
  fromEntityId: z.string(),
  toEntityId: z.string(),
  type: RelationshipTypeSchema,
  validFrom: z.string().datetime().nullable(),
  validTo: z.string().datetime().nullable(),
  confidenceScore: z.number().min(0).max(1).nullable(),
  sourceEventId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

/** A single asserted, versioned value about an entity — the atomic unit of "truth" in Veynlo. */
export const FactSchema = z.object({
  id: z.string(),
  subjectEntityId: z.string(),
  predicate: z.string(), // e.g. "warranty_expiration_date", "return_deadline", "premium_amount"
  valueJson: z.unknown(),
  unit: z.string().nullable(),
  provenance: ProvenanceSchema,
  effectiveFrom: z.string().datetime().nullable(),
  effectiveTo: z.string().datetime().nullable(),
  supersededByFactId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Fact = z.infer<typeof FactSchema>;
