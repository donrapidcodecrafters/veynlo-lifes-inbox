import { pgTable, text, timestamp, integer, real, jsonb, boolean, index } from "drizzle-orm/pg-core";
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
    // Phase 2 §52.2 "emergency binder" — until now this was ONLY an entitlement/plan-capability boolean
    // (packages/core/src/entitlements/plans.ts) with no actual feature/data behind it at all (see
    // household/dto.ts's own doc comment acknowledging the gap). A user opts a document into the binder
    // explicitly; it's never inferred from documentType, since "which documents matter in an emergency" is
    // a judgment call only the user should make (a random shipping receipt shouldn't show up next to a
    // passport just because both are "documents").
    isEmergencyBinderItem: boolean("is_emergency_binder_item").notNull().default(false),
    // Phase 3 §26 TRIP-006 "Travel document readiness" — a minimal identity-document concept added to the
    // existing Documents vault rather than a whole new identity-document subsystem, per this session's own
    // design note. `documentKind` is nullable/free-form-ish ("passport" | "drivers_license" | "national_id"
    // | ...) rather than a DB enum — a user classifies their own uploaded document, and a closed enum would
    // block a document type this app didn't anticipate. `expiresAt` is nullable and only ever set by the
    // user (never inferred from OCR text — no jurisdiction/format-specific expiry parser exists here), same
    // "don't invent what isn't there" stance as everywhere else in this codebase. TripsService reads these
    // two columns (scoped to `documentKind === "passport"`) to compare against upcoming trip dates —
    // see AttentionService.scanAndFileDeadlines's `travelDocuments` block.
    documentKind: text("document_kind"),
    expiresAt: jsonb("expires_at").$type<TemporalValue>(),
    expiresAtSort: timestamp("expires_at_sort", { withTimezone: true }),
    processingState: text("processing_state").notNull().default("uploaded"),
    // §40.3 "Representative state machines" (Document row) — snapshot of `processingState` taken the
    // moment a document is archived (DocumentsService.archive), so DocumentsService.unarchive can restore
    // the exact pipeline stage (or "superseded") the document was in rather than guessing one from other
    // columns. Null whenever the document isn't currently archived; cleared again on unarchive. Mirrors
    // this table's own `expiresAt`/`documentKind` precedent of a plain nullable column for a
    // narrow, single-feature concern rather than a new table.
    previousProcessingState: text("previous_processing_state"),
    // §40.3 Document state machine's "verified" — set the moment a user explicitly confirms this
    // document's extracted content/classification is correct (DocumentsService.verify), as opposed to it
    // just being an AI-extracted guess sitting unconfirmed (same DEC-001 "confirm/correct state" posture
    // InboxService.confirm already applies to purchases/pet-vaccinations). Kept alongside
    // `processingState: "verified"` rather than only inferred from it, so a later archive/unarchive round
    // trip never loses *when* it was verified.
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    // §40.3 Document state machine's "superseded" — set on the OLDER document once a newer upload is
    // confidently recognized as replacing it (DocumentsService.upload's automatic exact-content-hash path,
    // or the explicit DocumentsService.markSuperseded action for a corrected/amended document whose bytes
    // differ). Deliberately a plain text pointer with no FK, matching this table's own `sourceEventId`
    // column precedent — a best-effort lineage pointer for the UI ("replaced by…"), not a hard relational
    // dependency that would complicate this table's own cascade-delete shape.
    supersededByDocumentId: text("superseded_by_document_id"),
    currentVersionId: text("current_version_id"),
    // MAIL-004 "Attachment intelligence" — "Attachments inherit message provenance." Set only when this
    // document was created from an email attachment (see IngestionService.processEmailAttachments), never
    // for a plain user upload (DocumentsService.upload's other callers all omit it, leaving this null).
    // Deliberately a plain text column with no FK, matching every other `sourceEventId` evidence-link
    // column in this schema (commerce.ts/assets.ts/school.ts/travel.ts/health.ts all do the same) rather
    // than a referential constraint — the point is a best-effort provenance pointer for the evidence view,
    // not a hard relational dependency.
    sourceEventId: text("source_event_id"),
    linkedEntityIds: jsonb("linked_entity_ids").$type<string[]>().notNull().default([]),
    tags: encryptedJsonb<string[]>("tags", []).notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("documents_owner_idx").on(t.ownerUserId), index("documents_expires_at_idx").on(t.expiresAtSort)],
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
