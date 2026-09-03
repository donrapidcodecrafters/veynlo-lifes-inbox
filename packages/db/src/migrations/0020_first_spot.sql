CREATE TABLE "store_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"merchant_id" text,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expiration_date" jsonb,
	"expiration_date_sort" timestamp with time zone,
	"source_return_case_id" text,
	"source_event_id" text,
	"redeemed" boolean DEFAULT false NOT NULL,
	"redeemed_at" timestamp with time zone,
	"confidence_band" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "store_credits" ADD CONSTRAINT "store_credits_source_return_case_id_return_cases_id_fk" FOREIGN KEY ("source_return_case_id") REFERENCES "public"."return_cases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "store_credits_owner_idx" ON "store_credits" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "store_credits_expiration_idx" ON "store_credits" USING btree ("expiration_date_sort");