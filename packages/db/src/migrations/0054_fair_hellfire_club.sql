CREATE TABLE "transaction_revisions" (
	"id" text PRIMARY KEY NOT NULL,
	"financial_transaction_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"amount_minor_units" integer NOT NULL,
	"pending" boolean NOT NULL,
	"posted_date" text,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prepared_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"merchant_id" text,
	"title" text NOT NULL,
	"steps" jsonb NOT NULL,
	"source_note" text,
	"state" text DEFAULT 'pending_confirmation' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prepared_actions_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
ALTER TABLE "dependent_profiles" ADD COLUMN "transition_invited_email" text;--> statement-breakpoint
ALTER TABLE "dependent_profiles" ADD COLUMN "transition_invite_token_hash" text;--> statement-breakpoint
ALTER TABLE "dependent_profiles" ADD COLUMN "transition_invite_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD COLUMN "trigger_merchant_id" text;--> statement-breakpoint
ALTER TABLE "personalization_preferences" ADD COLUMN "financial_privacy_mode_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "transaction_revisions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_actions" ADD CONSTRAINT "prepared_actions_run_id_automation_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."automation_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_actions" ADD CONSTRAINT "prepared_actions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_actions" ADD CONSTRAINT "prepared_actions_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prepared_actions" ADD CONSTRAINT "prepared_actions_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transaction_revisions_transaction_idx" ON "transaction_revisions" USING btree ("financial_transaction_id");--> statement-breakpoint
CREATE INDEX "transaction_revisions_owner_idx" ON "transaction_revisions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "prepared_actions_owner_state_idx" ON "prepared_actions" USING btree ("owner_user_id","state");--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_trigger_merchant_id_merchants_id_fk" FOREIGN KEY ("trigger_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dependent_profiles" ADD CONSTRAINT "dependent_profiles_transition_invite_token_hash_unique" UNIQUE("transition_invite_token_hash");