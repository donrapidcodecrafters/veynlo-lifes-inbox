ALTER TABLE "calendar_events" ADD COLUMN "linked_event_id" text;--> statement-breakpoint
ALTER TABLE "schedule_conflicts" ADD COLUMN "severity" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedule_conflicts" ADD COLUMN "unavailable_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "calendar_events_linked_event_idx" ON "calendar_events" USING btree ("linked_event_id");