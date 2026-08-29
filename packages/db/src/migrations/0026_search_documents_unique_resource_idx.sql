DROP INDEX "search_documents_resource_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "search_documents_resource_idx" ON "search_documents" USING btree ("resource_type","resource_id");