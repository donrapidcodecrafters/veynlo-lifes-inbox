ALTER TABLE "home_assets" ADD COLUMN "room" text;--> statement-breakpoint
ALTER TABLE "vehicle_profiles" ADD COLUMN "vin_decoded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "vehicle_profiles" ADD COLUMN "vin_decode_attributes" jsonb;--> statement-breakpoint
ALTER TABLE "search_documents" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('english', coalesce("search_documents"."title", '')), 'A') || setweight(to_tsvector('english', coalesce("search_documents"."body_text", '')), 'B')) STORED;--> statement-breakpoint
CREATE INDEX "search_documents_search_vector_idx" ON "search_documents" USING gin ("search_vector");