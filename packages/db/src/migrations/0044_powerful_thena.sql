CREATE TABLE "merchant_price_adjustment_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"merchant_id" text NOT NULL,
	"owner_user_id" text,
	"window_days" integer NOT NULL,
	"confidence" text NOT NULL,
	"source_note" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "merchant_price_adjustment_policies" ADD CONSTRAINT "merchant_price_adjustment_policies_merchant_id_merchants_id_fk" FOREIGN KEY ("merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_price_adjustment_policies" ADD CONSTRAINT "merchant_price_adjustment_policies_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "merchant_price_adjustment_policies_merchant_idx" ON "merchant_price_adjustment_policies" USING btree ("merchant_id");--> statement-breakpoint
CREATE INDEX "merchant_price_adjustment_policies_owner_idx" ON "merchant_price_adjustment_policies" USING btree ("owner_user_id");