CREATE TABLE "home_assets" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"property_profile_id" text NOT NULL,
	"label" text NOT NULL,
	"category" text,
	"make" text,
	"model" text,
	"serial" text,
	"install_date" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "odometer_observations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"vehicle_profile_id" text NOT NULL,
	"mileage" integer NOT NULL,
	"observed_at" jsonb NOT NULL,
	"observed_at_sort" timestamp with time zone,
	"source" text DEFAULT 'user_entered' NOT NULL,
	"confidence_band" text DEFAULT 'verified' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recall_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"vehicle_profile_id" text,
	"home_asset_id" text,
	"source" text NOT NULL,
	"campaign_number" text NOT NULL,
	"component" text,
	"summary" text NOT NULL,
	"remedy" text,
	"url" text,
	"matched_make" text,
	"matched_model" text,
	"matched_year" integer,
	"status" text DEFAULT 'potential_match_verify_vin' NOT NULL,
	"reported_date" jsonb,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tires" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"vehicle_profile_id" text NOT NULL,
	"brand" text,
	"model" text,
	"size" text,
	"install_date" jsonb,
	"install_mileage" integer,
	"rotation_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pressure_spec_psi" integer,
	"warranty_months" integer,
	"road_hazard_warranty" text,
	"status" text DEFAULT 'active' NOT NULL,
	"replaced_at" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "home_assets" ADD CONSTRAINT "home_assets_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_assets" ADD CONSTRAINT "home_assets_property_profile_id_property_profiles_id_fk" FOREIGN KEY ("property_profile_id") REFERENCES "public"."property_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_observations" ADD CONSTRAINT "odometer_observations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "odometer_observations" ADD CONSTRAINT "odometer_observations_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_matches" ADD CONSTRAINT "recall_matches_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_matches" ADD CONSTRAINT "recall_matches_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recall_matches" ADD CONSTRAINT "recall_matches_home_asset_id_home_assets_id_fk" FOREIGN KEY ("home_asset_id") REFERENCES "public"."home_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tires" ADD CONSTRAINT "tires_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tires" ADD CONSTRAINT "tires_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "home_assets_property_idx" ON "home_assets" USING btree ("property_profile_id");--> statement-breakpoint
CREATE INDEX "odometer_observations_vehicle_idx" ON "odometer_observations" USING btree ("vehicle_profile_id","observed_at_sort");--> statement-breakpoint
CREATE INDEX "recall_matches_vehicle_idx" ON "recall_matches" USING btree ("vehicle_profile_id");--> statement-breakpoint
CREATE INDEX "recall_matches_home_asset_idx" ON "recall_matches" USING btree ("home_asset_id");--> statement-breakpoint
CREATE INDEX "recall_matches_campaign_idx" ON "recall_matches" USING btree ("source","campaign_number");--> statement-breakpoint
CREATE INDEX "tires_vehicle_idx" ON "tires" USING btree ("vehicle_profile_id");