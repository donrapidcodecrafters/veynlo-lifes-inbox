ALTER TABLE "merchant_merge_lineage" ADD COLUMN "repointed_store_credit_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "merchant_merge_lineage" ADD COLUMN "repointed_recurring_stream_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "voided_at" timestamp with time zone;