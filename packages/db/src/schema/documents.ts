import { pgTable, text, timestamp, integer, real, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { sensitivityTierEnum, visibilityEnum } from "./common";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

export const documents = pgTable(
  "documents",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    documentType: text("document_type").notNull(),
    // Encrypted — read via raw SQL in TimelineService, which manually decrypts it after the query.
    title: encryptedText("title").notNull(),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    processingState: text("processing_state").notNull().default("uploaded"),
    // Set alongside processingState "quarantined" (malware detected — the signature name) or
    // "failed_user_action" (OCR/extraction genuinely threw, e.g. a password-protected PDF) — the real,
    // user-facing reason, instead of the previous silently-server-log-only posture. Cleared implicitly by
    // never being set again once processing succeeds normally.
    processingError: encryptedText("processing_error"),
    currentVersionId: text("current_version_id"),
    // DOC-008 "retention policy" — "full_original" keeps the actual file bytes in S3 (the default);
    // "extracted_only" or "delete_after_processing" both mean the blob is deleted (their OCR'd text, which
    // already exists independently on document_versions, is what's kept) — DocumentsService.setRetention
    // is the only writer of this deletion. A document can only move toward deleting its original, never
    // back — there's nothing to restore a deleted blob from.
    retentionPolicy: text("retention_policy").notNull().default("full_original"),
    linkedEntityIds: jsonb("linked_entity_ids").$type<string[]>().notNull().default([]),
    tags: encryptedJsonb<string[]>("tags").notNull().default([]),
    // DOC-005 "deadline/obligation extraction" — AI-extracted from the document's OCR'd content (a
    // contract renewal date, a permit expiration, an insurance policy end date) at upload/version-replace
    // time. Null when no deadline was found/extractable, same "absence means genuinely nothing found, not
    // a stuck pipeline" posture as ocrText. `extractedDeadlineSort` mirrors bills.dueDateSort/warranties.
    // expirationDateSort's plain-timestamp-for-range-queries pattern; AttentionService.scanAndFileDeadlines
    // reads it the same way.
    extractedDeadline: jsonb("extracted_deadline").$type<TemporalValue>(),
    extractedDeadlineSort: timestamp("extracted_deadline_sort", { withTimezone: true }),
    extractedDeadlineLabel: encryptedText("extracted_deadline_label"),
    // Unlike the other domains AttentionService.scanAndFileDeadlines files from (bills/warranties/returns,
    // already-structured facts by scan time), this one really is a free-text AI guess — a real
    // confidenceToBand() result (RiskPolicyService, domain "document_deadline"), not a hardcoded "verified".
    extractedDeadlineConfidenceBand: text("extracted_deadline_confidence_band"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  // Composite (ownerUserId, createdAt) also serves owner-only lookups via its leftmost column, so it
  // replaces the old owner-only index rather than sitting alongside it — cursor pagination (order by
  // createdAt desc) can walk this index in order instead of doing an extra sort.
  (t) => [index("documents_owner_created_idx").on(t.ownerUserId, t.createdAt), index("documents_deadline_idx").on(t.extractedDeadlineSort)],
);

export const documentVersions = pgTable("document_versions", {
  id: text("id").primaryKey(),
  documentId: text("document_id")
    .notNull()
    .references(() => documents.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull().default(1),
  blobRef: text("blob_ref").notNull(),
  contentHash: text("content_hash").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  ocrText: encryptedText("ocr_text"),
  ocrConfidence: real("ocr_confidence"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
