CREATE TABLE "financial_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"connection_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"plaid_account_id" text NOT NULL,
	"name" text NOT NULL,
	"official_name" text,
	"type" text NOT NULL,
	"subtype" text,
	"mask" text,
	"current_balance_minor_units" integer,
	"available_balance_minor_units" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"plaid_transaction_id" text NOT NULL,
	"name" text NOT NULL,
	"merchant_name" text,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"category" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pending" boolean DEFAULT false NOT NULL,
	"posted_date" text,
	"matched_purchase_id" text,
	"matched_bill_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_accounts" ADD CONSTRAINT "financial_accounts_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_matched_purchase_id_purchases_id_fk" FOREIGN KEY ("matched_purchase_id") REFERENCES "public"."purchases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_transactions" ADD CONSTRAINT "financial_transactions_matched_bill_id_bills_id_fk" FOREIGN KEY ("matched_bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "financial_accounts_owner_idx" ON "financial_accounts" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "financial_accounts_connection_idx" ON "financial_accounts" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "financial_transactions_owner_idx" ON "financial_transactions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "financial_transactions_account_idx" ON "financial_transactions" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "financial_transactions_plaid_id_idx" ON "financial_transactions" USING btree ("plaid_transaction_id");