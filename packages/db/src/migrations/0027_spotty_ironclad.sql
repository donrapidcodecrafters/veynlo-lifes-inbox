ALTER TABLE "saved_items" DROP CONSTRAINT "saved_items_created_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "saved_items" ALTER COLUMN "created_by_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_items" ADD CONSTRAINT "saved_items_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_events_source_external_id_idx" ON "billing_events" USING btree ("source","external_event_id");