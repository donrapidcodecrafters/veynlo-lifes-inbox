import { z } from "zod";
import { ProvenanceSchema } from "./provenance";
import { SensitivityTierSchema, VisibilitySchema } from "../permissions/sensitivity";

export const DocumentTypeSchema = z.enum([
  "receipt",
  "warranty",
  "insurance_policy",
  "contract",
  "manual",
  "tax_document",
  "registration",
  "title",
  "identity_document",
  "membership_document",
  "statement",
  "invitation",
  // HLTH-002 "insurance card/document vault" — a dedicated categorization for health-sensitive documents
  // (insurance cards, explanation-of-benefits statements) so they can be filtered/found as their own
  // category and, in DocumentsService.upload, default to the "highly_sensitive" tier rather than the
  // ordinary "sensitive" default every other document type gets. Deliberately reuses the existing
  // documents vault (sensitivity/visibility/step-up machinery) rather than a parallel health-document
  // system — see services/api/src/modules/health-logistics's own module doc comment.
  "insurance_card",
  "eob",
  "other",
]);
export type DocumentType = z.infer<typeof DocumentTypeSchema>;

export const DocumentProcessingStateSchema = z.enum([
  "uploaded",
  "malware_scan",
  "ocr_parsing",
  "classified",
  "extracted",
  "linked",
  "verified",
  "superseded",
  "archived",
  "deleted",
]);
export type DocumentProcessingState = z.infer<typeof DocumentProcessingStateSchema>;

export const DocumentSchema = z.object({
  id: z.string(),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  documentType: DocumentTypeSchema,
  title: z.string(),
  sensitivity: SensitivityTierSchema,
  visibility: VisibilitySchema,
  processingState: DocumentProcessingStateSchema,
  currentVersionId: z.string().nullable(),
  linkedEntityIds: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type Document = z.infer<typeof DocumentSchema>;

export const DocumentVersionSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  versionNumber: z.number().int().min(1),
  blobRef: z.string(), // object storage key — never a public URL
  contentHash: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  ocrText: z.string().nullable(),
  ocrConfidence: z.number().min(0).max(1).nullable(),
  provenance: ProvenanceSchema.nullable(),
  createdAt: z.string().datetime(),
});
export type DocumentVersion = z.infer<typeof DocumentVersionSchema>;
