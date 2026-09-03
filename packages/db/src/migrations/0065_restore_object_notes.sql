-- TIME-002 "Object history" — restores the `object_notes` table.
--
-- This table and its HistoryModule were built on the pre-2026-08-26 line of history and were lost when
-- main was force-pushed to the Mac's diverged branch on 2026-09-03 (the old line is preserved on
-- origin/pre-mac-sync-backup-2026-09-03, where this table was originally created by
-- 0017_marvelous_wrecker.sql). The DDL below is a verbatim port of that original.
--
-- Written by hand rather than via `drizzle-kit generate`, and deliberately guarded with IF NOT EXISTS,
-- so it is safe to apply to a database that still has the original table from the old line.
CREATE TABLE IF NOT EXISTS "object_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"note_text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE "object_notes" ADD CONSTRAINT "object_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
	WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "object_notes_resource_idx" ON "object_notes" USING btree ("resource_type","resource_id");
