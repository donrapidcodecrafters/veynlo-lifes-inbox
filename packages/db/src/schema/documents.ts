import { pgTable, text, timestamp, integer, real, jsonb, index } from "drizzle-orm/pg-core";
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
    currentVersionId: text("current_version_id"),
    // DOC-008 "retention policy" — "full_original" keeps the actual file bytes in S3 (the default);
    // "extracted_only" or "delete_after_processing" both mean the blob is deleted (their OCR'd text, which
    // already exists independently on document_versions, is what's kept) — DocumentsService.setRetention
    // is the only writer of this deletion. A document can only move toward deleting its original, never
    // back — there's nothing to restore a deleted blob from.
    retentionPolicy: text("retention_policy").notNull().default("full_original"),
    linkedEntityIds: jsonb("linked_entity_ids").$type<string[]>().notNull().default([]),
    tags: encryptedJsonb<string[]>("tags").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("documents_owner_idx").on(t.ownerUserId)],
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
