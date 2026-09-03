import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { vector } from "./vector-type";
import { tsvector } from "./tsvector-type";

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
    // §44.4 "Semantic ... embedding similarity" — real semantic search needs a configured, paid embedding
    // provider, which is credential-blocked/out of scope for this phase. This column stays declared but
    // completely unused (never written, never queried) until that phase lands; do not read from or write
    // to it as a substitute for the full-text `searchVector` column below.
    embedding: vector("embedding", { dimensions: 1536 }),
    // §44.4 "Full text ... Postgres FTS initially" — a STORED generated column, not a trigger: Postgres
    // recomputes it automatically from `title`/`bodyText` on every INSERT/UPDATE, so SearchIndexService
    // (services/api/src/modules/search/search-index.service.ts) never has to maintain it by hand, and it
    // can never drift out of sync with the text columns it's derived from. `setweight` ranks a title match
    // ('A') above a body match ('B') so `ts_rank` naturally orders an exact/title hit ahead of one that only
    // matches deep in the body text.
    //
    // References `searchDocuments.title`/`searchDocuments.bodyText` (the table binding being defined right
    // here) rather than plain column names — this works because `generatedAlwaysAs` takes a *function*,
    // called lazily (when the schema is introspected/migrated), by which point the `searchDocuments` const
    // below has already been assigned.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      (): SQL =>
        sql`setweight(to_tsvector('english', coalesce(${searchDocuments.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${searchDocuments.bodyText}, '')), 'B')`,
    ),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("search_documents_owner_idx").on(t.ownerUserId),
    index("search_documents_resource_idx").on(t.resourceType, t.resourceId),
    // §44.4 "Postgres FTS initially" — GIN is the standard index type for tsvector `@@`/`ts_rank` queries.
    index("search_documents_search_vector_idx").using("gin", t.searchVector),
  ],
);
