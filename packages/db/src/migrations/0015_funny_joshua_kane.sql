CREATE TABLE "sender_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"sender_address" text NOT NULL,
	"action" text NOT NULL,
	"category_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sender_rules" ADD CONSTRAINT "sender_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sender_rules_owner_address_idx" ON "sender_rules" USING btree ("owner_user_id","sender_address");