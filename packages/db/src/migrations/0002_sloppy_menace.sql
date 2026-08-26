CREATE TABLE "merchant_merge_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"surviving_merchant_id" text NOT NULL,
	"merged_merchant_id" text NOT NULL,
	"merged_merchant_snapshot" jsonb NOT NULL,
	"repointed_purchase_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_admin_id" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "merchants" ADD COLUMN "merged_into_merchant_id" text;--> statement-breakpoint
ALTER TABLE "merchant_merge_lineage" ADD CONSTRAINT "merchant_merge_lineage_surviving_merchant_id_merchants_id_fk" FOREIGN KEY ("surviving_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_merge_lineage" ADD CONSTRAINT "merchant_merge_lineage_merged_merchant_id_merchants_id_fk" FOREIGN KEY ("merged_merchant_id") REFERENCES "public"."merchants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "merchant_merge_lineage" ADD CONSTRAINT "merchant_merge_lineage_actor_admin_id_admin_users_id_fk" FOREIGN KEY ("actor_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE no action ON UPDATE no action;