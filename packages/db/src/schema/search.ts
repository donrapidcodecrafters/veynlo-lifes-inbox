import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
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
    title: text("title").notNull(),
    bodyText: text("body_text").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    embedding: vector("embedding", { dimensions: 1536 }),
    indexedAt: timestamp("indexed_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("search_documents_owner_idx").on(t.ownerUserId),
    index("search_documents_resource_idx").on(t.resourceType, t.resourceId),
  ],
);
