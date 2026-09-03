CREATE TABLE "calendar_reschedule_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"inbox_item_id" text NOT NULL,
	"calendar_event_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"sender_domain" text,
	"proposed_start" jsonb NOT NULL,
	"proposed_is_all_day" boolean DEFAULT false NOT NULL,
	"proposed_location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_reschedule_trusted_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"sender_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calendar_reschedule_proposals" ADD CONSTRAINT "calendar_reschedule_proposals_inbox_item_id_inbox_items_id_fk" FOREIGN KEY ("inbox_item_id") REFERENCES "public"."inbox_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reschedule_proposals" ADD CONSTRAINT "calendar_reschedule_proposals_calendar_event_id_calendar_events_id_fk" FOREIGN KEY ("calendar_event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reschedule_proposals" ADD CONSTRAINT "calendar_reschedule_proposals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_reschedule_trusted_rules" ADD CONSTRAINT "calendar_reschedule_trusted_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_reschedule_trusted_rules_owner_domain_idx" ON "calendar_reschedule_trusted_rules" USING btree ("owner_user_id","sender_domain");