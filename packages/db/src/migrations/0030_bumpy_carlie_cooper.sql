DROP INDEX "documents_owner_idx";--> statement-breakpoint
DROP INDEX "inbox_items_owner_state_idx";--> statement-breakpoint
CREATE INDEX "connections_health_disconnected_idx" ON "connections" USING btree ("health","disconnected_at");--> statement-breakpoint
CREATE INDEX "bills_owner_idx" ON "bills" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "warranties_owner_idx" ON "warranties" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "documents_owner_created_idx" ON "documents" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "entitlements_user_idx" ON "entitlements" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "extraction_runs_started_at_idx" ON "extraction_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "extraction_runs_status_started_idx" ON "extraction_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE INDEX "inbox_items_owner_state_idx" ON "inbox_items" USING btree ("owner_user_id","review_state","created_at");