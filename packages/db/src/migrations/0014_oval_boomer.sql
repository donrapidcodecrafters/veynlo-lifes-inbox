ALTER TABLE "sessions" ADD COLUMN "previous_refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "refresh_expires_at" timestamp with time zone;