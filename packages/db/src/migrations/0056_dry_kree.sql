CREATE TABLE "maintenance_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"vehicle_profile_id" text,
	"home_asset_id" text,
	"label" text NOT NULL,
	"interval_type" text NOT NULL,
	"interval_days" integer,
	"interval_miles" integer,
	"baseline_mileage" integer,
	"last_performed_date" jsonb,
	"last_performed_date_sort" timestamp with time zone,
	"source" text DEFAULT 'user_added' NOT NULL,
	"confidence_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "registration_records" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"vehicle_profile_id" text NOT NULL,
	"record_type" text DEFAULT 'registration' NOT NULL,
	"jurisdiction" text,
	"renewal_due_date" jsonb,
	"renewal_due_date_sort" timestamp with time zone,
	"reminder_lead_days" integer DEFAULT 30 NOT NULL,
	"last_renewed_date" jsonb,
	"notes" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "maintenance_rules" ADD CONSTRAINT "maintenance_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_rules" ADD CONSTRAINT "maintenance_rules_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_rules" ADD CONSTRAINT "maintenance_rules_home_asset_id_home_assets_id_fk" FOREIGN KEY ("home_asset_id") REFERENCES "public"."home_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_records" ADD CONSTRAINT "registration_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_records" ADD CONSTRAINT "registration_records_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_rules_vehicle_idx" ON "maintenance_rules" USING btree ("vehicle_profile_id");--> statement-breakpoint
CREATE INDEX "maintenance_rules_home_asset_idx" ON "maintenance_rules" USING btree ("home_asset_id");--> statement-breakpoint
CREATE INDEX "registration_records_vehicle_idx" ON "registration_records" USING btree ("vehicle_profile_id");--> statement-breakpoint
CREATE INDEX "registration_records_due_idx" ON "registration_records" USING btree ("renewal_due_date_sort");