ALTER TABLE "smart_connections" ADD COLUMN "api_base_url" text;--> statement-breakpoint
ALTER TABLE "smart_connections" ADD COLUMN "api_token" text;--> statement-breakpoint
ALTER TABLE "smart_connections" ADD COLUMN "health_detail" text;--> statement-breakpoint
ALTER TABLE "smart_connections" ADD COLUMN "last_successful_sync_at" timestamp with time zone;