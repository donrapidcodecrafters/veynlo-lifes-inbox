-- Real Postgres full-text search over search_documents. title/body_text are plaintext by design (see the
-- schema comment on search_documents) specifically so they can be indexed this way — the source-of-truth
-- columns they mirror (documents.title, bills.billerLabel, calendarEvents.title) stay encrypted at rest.
ALTER TABLE "search_documents"
  ADD COLUMN "search_vector" tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("body_text", '')), 'B')
  ) STORED;
--> statement-breakpoint
CREATE INDEX "search_documents_search_vector_idx" ON "search_documents" USING gin ("search_vector");
