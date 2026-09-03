CREATE TABLE "pet_merge_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"surviving_pet_id" text NOT NULL,
	"merged_pet_id" text NOT NULL,
	"merged_pet_snapshot" jsonb NOT NULL,
	"repointed_vaccination_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_refill_reminder_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_maintenance_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_bill_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "property_merge_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"surviving_property_id" text NOT NULL,
	"merged_property_id" text NOT NULL,
	"merged_property_snapshot" jsonb NOT NULL,
	"repointed_maintenance_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_home_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_warranty_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicle_merge_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"surviving_vehicle_id" text NOT NULL,
	"merged_vehicle_id" text NOT NULL,
	"merged_vehicle_snapshot" jsonb NOT NULL,
	"repointed_maintenance_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_odometer_observation_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_tire_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_recall_match_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_maintenance_rule_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_registration_record_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_warranty_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "model_eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"model_key" text NOT NULL,
	"golden_set_version" text NOT NULL,
	"total_cases" integer NOT NULL,
	"passed_cases" integer NOT NULL,
	"pass_rate" real NOT NULL,
	"by_schema" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"triggered_by" text,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_registry" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"model_key" text NOT NULL,
	"tier" text NOT NULL,
	"display_name" text NOT NULL,
	"supported_tasks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"max_context_tokens" integer NOT NULL,
	"structured_output_reliability" text NOT NULL,
	"latency_class" text NOT NULL,
	"cost_class" text NOT NULL,
	"regions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"privacy_retention_note" text,
	"launch_status" text DEFAULT 'ga' NOT NULL,
	"deprecated_at" timestamp with time zone,
	"sunset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_registry_model_key_unique" UNIQUE("model_key")
);
--> statement-breakpoint
CREATE TABLE "product_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_name" text NOT NULL,
	"user_id" text,
	"household_id" text,
	"platform" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pet_profiles" ADD COLUMN "merged_into_pet_id" text;--> statement-breakpoint
ALTER TABLE "property_profiles" ADD COLUMN "merged_into_property_id" text;--> statement-breakpoint
ALTER TABLE "vehicle_profiles" ADD COLUMN "merged_into_vehicle_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "previous_processing_state" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "superseded_by_document_id" text;--> statement-breakpoint
ALTER TABLE "pet_merge_lineage" ADD CONSTRAINT "pet_merge_lineage_surviving_pet_id_pet_profiles_id_fk" FOREIGN KEY ("surviving_pet_id") REFERENCES "public"."pet_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_merge_lineage" ADD CONSTRAINT "pet_merge_lineage_merged_pet_id_pet_profiles_id_fk" FOREIGN KEY ("merged_pet_id") REFERENCES "public"."pet_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_merge_lineage" ADD CONSTRAINT "pet_merge_lineage_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_merge_lineage" ADD CONSTRAINT "property_merge_lineage_surviving_property_id_property_profiles_id_fk" FOREIGN KEY ("surviving_property_id") REFERENCES "public"."property_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_merge_lineage" ADD CONSTRAINT "property_merge_lineage_merged_property_id_property_profiles_id_fk" FOREIGN KEY ("merged_property_id") REFERENCES "public"."property_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_merge_lineage" ADD CONSTRAINT "property_merge_lineage_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_merge_lineage" ADD CONSTRAINT "vehicle_merge_lineage_surviving_vehicle_id_vehicle_profiles_id_fk" FOREIGN KEY ("surviving_vehicle_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_merge_lineage" ADD CONSTRAINT "vehicle_merge_lineage_merged_vehicle_id_vehicle_profiles_id_fk" FOREIGN KEY ("merged_vehicle_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_merge_lineage" ADD CONSTRAINT "vehicle_merge_lineage_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_events" ADD CONSTRAINT "product_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pet_merge_lineage_surviving_idx" ON "pet_merge_lineage" USING btree ("surviving_pet_id");--> statement-breakpoint
CREATE INDEX "property_merge_lineage_surviving_idx" ON "property_merge_lineage" USING btree ("surviving_property_id");--> statement-breakpoint
CREATE INDEX "vehicle_merge_lineage_surviving_idx" ON "vehicle_merge_lineage" USING btree ("surviving_vehicle_id");--> statement-breakpoint
CREATE INDEX "product_events_name_time_idx" ON "product_events" USING btree ("event_name","occurred_at");--> statement-breakpoint
CREATE INDEX "product_events_user_idx" ON "product_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "product_events_household_idx" ON "product_events" USING btree ("household_id");