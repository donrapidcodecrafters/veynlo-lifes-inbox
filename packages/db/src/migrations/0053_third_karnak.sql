CREATE TYPE "public"."sender_rule_action" AS ENUM('always_school', 'always_bills', 'ignore', 'attachments_only', 'household_shared');--> statement-breakpoint
CREATE TABLE "merchant_cancellation_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"owner_user_id" text,
	"steps" jsonb NOT NULL,
	"source_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sender_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"sender_domain" text,
	"sender_email" text,
	"action" "sender_rule_action" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "parser_version" integer;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "source_event_id" text;--> statement-breakpoint
ALTER TABLE "merchant_cancellation_steps" ADD CONSTRAINT "merchant_cancellation_steps_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_cancellation_steps" ADD CONSTRAINT "merchant_cancellation_steps_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sender_rules" ADD CONSTRAINT "sender_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_cancellation_steps_merchant_idx" ON "merchant_cancellation_steps" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_cancellation_steps_owner_idx" ON "merchant_cancellation_steps" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_rules_owner_domain_idx" ON "sender_rules" USING btree ("owner_user_id","sender_domain");--> statement-breakpoint
CREATE UNIQUE INDEX "sender_rules_owner_email_idx" ON "sender_rules" USING btree ("owner_user_id","sender_email");