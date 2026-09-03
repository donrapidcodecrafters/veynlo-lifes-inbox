CREATE TABLE "connection_exclusions" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"excluded_sender_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "detected_income_streams" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"stream_key" text NOT NULL,
	"description" text NOT NULL,
	"cadence" text NOT NULL,
	"average_amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"occurrence_count" integer NOT NULL,
	"last_occurrence_date" text,
	"dismissed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "liabilities" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"minimum_payment_minor_units" integer,
	"due_date" text,
	"apr_basis_points" integer,
	"last_statement_balance_minor_units" integer,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "liabilities_account_id_unique" UNIQUE("account_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "scheduled_deletion_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "ai_processing_enabled" boolean;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD COLUMN "is_included" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "selected_categories" jsonb;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "item_count" integer;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD COLUMN "estimated_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "connection_exclusions" ADD CONSTRAINT "connection_exclusions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_income_streams" ADD CONSTRAINT "detected_income_streams_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "detected_income_streams" ADD CONSTRAINT "detected_income_streams_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "liabilities" ADD CONSTRAINT "liabilities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "connection_exclusions_connection_idx" ON "connection_exclusions" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "detected_income_streams_owner_idx" ON "detected_income_streams" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "detected_income_streams_account_stream_idx" ON "detected_income_streams" USING btree ("account_id","stream_key");--> statement-breakpoint
CREATE INDEX "liabilities_owner_idx" ON "liabilities" USING btree ("owner_user_id");