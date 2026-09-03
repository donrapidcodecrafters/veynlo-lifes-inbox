CREATE TABLE "maintenance_records" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"property_profile_id" text,
	"vehicle_profile_id" text,
	"description" text NOT NULL,
	"service_date" jsonb,
	"service_date_sort" timestamp with time zone,
	"cost_minor_units" integer,
	"cost_currency" text,
	"confidence_band" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "property_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"label" text NOT NULL,
	"property_type" text DEFAULT 'home' NOT NULL,
	"address" text,
	"move_in_date" jsonb,
	"sensitivity" "sensitivity_tier" DEFAULT 'sensitive' NOT NULL,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicle_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"label" text NOT NULL,
	"make" text,
	"model" text,
	"year" integer,
	"vin" text,
	"purchase_date" jsonb,
	"sensitivity" "sensitivity_tier" DEFAULT 'sensitive' NOT NULL,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "property_profile_id" text;--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "vehicle_profile_id" text;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_property_profile_id_property_profiles_id_fk" FOREIGN KEY ("property_profile_id") REFERENCES "public"."property_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_profiles" ADD CONSTRAINT "property_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "property_profiles" ADD CONSTRAINT "property_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_profiles" ADD CONSTRAINT "vehicle_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_profiles" ADD CONSTRAINT "vehicle_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_records_property_idx" ON "maintenance_records" USING btree ("property_profile_id");--> statement-breakpoint
CREATE INDEX "maintenance_records_vehicle_idx" ON "maintenance_records" USING btree ("vehicle_profile_id");--> statement-breakpoint
CREATE INDEX "property_profiles_owner_idx" ON "property_profiles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "vehicle_profiles_owner_idx" ON "vehicle_profiles" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_property_profile_id_property_profiles_id_fk" FOREIGN KEY ("property_profile_id") REFERENCES "public"."property_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_vehicle_profile_id_vehicle_profiles_id_fk" FOREIGN KEY ("vehicle_profile_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE set null ON UPDATE no action;