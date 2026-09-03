ALTER TABLE "connections" ADD COLUMN "write_back_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "reminder_minutes_before" integer;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "write_back_connection_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "write_back_status" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_write_back_connection_id_connections_id_fk" FOREIGN KEY ("write_back_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;