ALTER TABLE "sync_runs" ADD COLUMN "status" text DEFAULT 'running' NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "pages_completed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD COLUMN "checkpoint" text;