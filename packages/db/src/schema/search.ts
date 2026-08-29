import { pgTable, text, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { vector } from "./vector-type";

/**
 * Search documents carry tenant/sensitivity metadata so authorization is
 * re-checked at fetch time — the index is never trusted as the sole ACL
 * (§44.4, §45 threat register "broken object authorization").
 */
export const searchDocuments = pgTable(
  "search_documents",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    householdId: text("household_id"),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    sensitivity: text("sensitivity").notNull(),
    // title/bodyText are deliberately NOT encrypted, unlike their source-of-truth columns elsewhere
    // (e.g. documents.title, purchases-derived titles) — this table exists specifically to be searched
    // (Postgres full-text/trigram matching, plus pgvector similarity on `embedding`), and application-level
    // encryption makes ciphertext opaque to exactly the operations search needs. Confidentiality for this
    // table has to come from a different layer: strict authz (re-checked at fetch time, per the comment
    // above), audit logging, and disk/volume-level encryption at rest (a standard managed-Postgres feature)
    // rather than column-level encryption. See SECURITY.md.
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    embedding: vector("embedding", { dimensions: 1536 }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("search_documents_owner_idx").on(t.ownerUserId),
    // Unique (not just indexed) so indexing writes can be a plain upsert keyed by the resource it mirrors —
    // one search_documents row per real resource, kept in sync on every create/update, removed on delete.
    uniqueIndex("search_documents_resource_idx").on(t.resourceType, t.resourceId),
  ],
);
