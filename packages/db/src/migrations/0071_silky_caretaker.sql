ALTER TYPE "public"."school_source_kind" ADD VALUE 'canvas';--> statement-breakpoint
ALTER TABLE "school_sources" ADD COLUMN "api_base_url" text;--> statement-breakpoint
ALTER TABLE "school_sources" ADD COLUMN "api_token" text;