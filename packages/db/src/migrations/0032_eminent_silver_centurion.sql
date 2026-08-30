ALTER TABLE "documents" ADD COLUMN "extracted_deadline" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_deadline_sort" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_deadline_label" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "extracted_deadline_confidence_band" text;--> statement-breakpoint
CREATE INDEX "documents_deadline_idx" ON "documents" USING btree ("extracted_deadline_sort");