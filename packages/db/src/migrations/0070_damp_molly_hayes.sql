CREATE TABLE "investment_holdings" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"security_id" text NOT NULL,
	"quantity" numeric(24, 8) NOT NULL,
	"institution_price" numeric(20, 6),
	"institution_price_as_of" text,
	"institution_value_minor_units" integer,
	"cost_basis_minor_units" integer,
	"currency" text DEFAULT 'USD' NOT NULL,
	"last_synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "securities" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"plaid_security_id" text NOT NULL,
	"name" text,
	"ticker_symbol" text,
	"type" text,
	"close_price" numeric(20, 6),
	"close_price_as_of" text,
	"currency" text DEFAULT 'USD' NOT NULL,
	"is_cash_equivalent" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "investment_holdings" ADD CONSTRAINT "investment_holdings_account_id_financial_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."financial_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_holdings" ADD CONSTRAINT "investment_holdings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "investment_holdings" ADD CONSTRAINT "investment_holdings_security_id_securities_id_fk" FOREIGN KEY ("security_id") REFERENCES "public"."securities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "securities" ADD CONSTRAINT "securities_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "investment_holdings_owner_idx" ON "investment_holdings" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "investment_holdings_account_idx" ON "investment_holdings" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "investment_holdings_account_security_idx" ON "investment_holdings" USING btree ("account_id","security_id");--> statement-breakpoint
CREATE INDEX "securities_owner_idx" ON "securities" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "securities_owner_plaid_security_idx" ON "securities" USING btree ("owner_user_id","plaid_security_id");