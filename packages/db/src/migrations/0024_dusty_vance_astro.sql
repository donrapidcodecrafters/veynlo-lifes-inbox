ALTER TABLE "tasks" ADD COLUMN "assignment_status" text DEFAULT 'unassigned' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "assignment_notes" text;