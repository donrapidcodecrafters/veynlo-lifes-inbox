CREATE TABLE "pet_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"label" text NOT NULL,
	"species" text,
	"breed" text,
	"birth_date" jsonb,
	"microchip_number" text,
	"photo_document_id" text,
	"vet_provider_name" text,
	"insurance_provider_name" text,
	"insurance_policy_number" text,
	"lifecycle_status" text DEFAULT 'active' NOT NULL,
	"sensitivity" "sensitivity_tier" DEFAULT 'sensitive' NOT NULL,
	"visibility" "visibility" DEFAULT 'household' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "pet_vaccinations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"pet_profile_id" text NOT NULL,
	"label" text NOT NULL,
	"document_id" text,
	"expiration_date" jsonb,
	"expiration_date_sort" timestamp with time zone,
	"source" text DEFAULT 'user_confirmed' NOT NULL,
	"confidence_band" text,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refill_reminders" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"pet_profile_id" text,
	"medication_name" text NOT NULL,
	"next_refill_date" jsonb NOT NULL,
	"next_refill_date_sort" timestamp with time zone,
	"pharmacy" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"geofence_id" text NOT NULL,
	"action_kind" text DEFAULT 'remind' NOT NULL,
	"action_title" text NOT NULL,
	"action_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geofence_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"geofence_id" text NOT NULL,
	"trigger_kind" text NOT NULL,
	"context_rule_fired" boolean DEFAULT false NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "geofences" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"place_id" text NOT NULL,
	"radius_meters" integer DEFAULT 150 NOT NULL,
	"trigger_kind" text DEFAULT 'arrival' NOT NULL,
	"native_identifier" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "location_permission_state" (
	"user_id" text PRIMARY KEY NOT NULL,
	"foreground_status" text DEFAULT 'undetermined' NOT NULL,
	"background_status" text DEFAULT 'undetermined' NOT NULL,
	"precision" text DEFAULT 'unknown' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "places" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"label" text NOT NULL,
	"address" text,
	"lat" double precision,
	"lng" double precision,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "travel_estimates" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"origin_place_id" text NOT NULL,
	"destination_place_id" text NOT NULL,
	"distance_meters" double precision NOT NULL,
	"estimated_minutes" integer NOT NULL,
	"method" text DEFAULT 'haversine_rough_estimate' NOT NULL,
	"uncertainty_note" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_signals" (
	"id" text PRIMARY KEY NOT NULL,
	"smart_device_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"signal_kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"detail" text,
	"dedupe_key" text NOT NULL,
	"attention_item_id" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smart_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"property_profile_id" text,
	"provider" text NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"selected_signal_kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"credential_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disconnected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "smart_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"smart_connection_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"property_profile_id" text,
	"provider_device_id" text NOT NULL,
	"label" text NOT NULL,
	"device_type" text NOT NULL,
	"room" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "travel_credits" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"trip_id" text,
	"source_segment_id" text,
	"provider_name" text,
	"amount_minor_units" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"expiration_date" jsonb,
	"expiration_date_sort" timestamp with time zone,
	"source_event_id" text,
	"redeemed" boolean DEFAULT false NOT NULL,
	"redeemed_at" timestamp with time zone,
	"confidence_band" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trip_segments" (
	"id" text PRIMARY KEY NOT NULL,
	"trip_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"provider_name" text,
	"confirmation_number" text,
	"location_label" text,
	"start_at" jsonb,
	"start_at_sort" timestamp with time zone,
	"end_at" jsonb,
	"end_at_sort" timestamp with time zone,
	"details_json" text NOT NULL,
	"cancellation_deadline" jsonb,
	"cancellation_deadline_sort" timestamp with time zone,
	"policy_evidence_text" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"disruption_status" text DEFAULT 'none' NOT NULL,
	"disruption_note" text,
	"disruption_detected_at" timestamp with time zone,
	"confidence_band" text,
	"source_event_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trips" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"label" text,
	"destination_label" text,
	"start_date" jsonb,
	"start_date_sort" timestamp with time zone,
	"end_date" jsonb,
	"end_date_sort" timestamp with time zone,
	"status" text DEFAULT 'upcoming' NOT NULL,
	"traveler_user_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"packing_list_id" text,
	"suggested_merge_trip_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD COLUMN "pet_profile_id" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "pet_profile_id" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "document_kind" text;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expires_at" jsonb;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "expires_at_sort" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pet_profiles" ADD CONSTRAINT "pet_profiles_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_profiles" ADD CONSTRAINT "pet_profiles_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_profiles" ADD CONSTRAINT "pet_profiles_photo_document_id_documents_id_fk" FOREIGN KEY ("photo_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_vaccinations" ADD CONSTRAINT "pet_vaccinations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_vaccinations" ADD CONSTRAINT "pet_vaccinations_pet_profile_id_pet_profiles_id_fk" FOREIGN KEY ("pet_profile_id") REFERENCES "public"."pet_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pet_vaccinations" ADD CONSTRAINT "pet_vaccinations_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD CONSTRAINT "refill_reminders_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD CONSTRAINT "refill_reminders_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD CONSTRAINT "refill_reminders_pet_profile_id_pet_profiles_id_fk" FOREIGN KEY ("pet_profile_id") REFERENCES "public"."pet_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_rules" ADD CONSTRAINT "context_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_rules" ADD CONSTRAINT "context_rules_geofence_id_geofences_id_fk" FOREIGN KEY ("geofence_id") REFERENCES "public"."geofences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofence_events" ADD CONSTRAINT "geofence_events_geofence_id_geofences_id_fk" FOREIGN KEY ("geofence_id") REFERENCES "public"."geofences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "geofences" ADD CONSTRAINT "geofences_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_permission_state" ADD CONSTRAINT "location_permission_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_estimates" ADD CONSTRAINT "travel_estimates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_estimates" ADD CONSTRAINT "travel_estimates_origin_place_id_places_id_fk" FOREIGN KEY ("origin_place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_estimates" ADD CONSTRAINT "travel_estimates_destination_place_id_places_id_fk" FOREIGN KEY ("destination_place_id") REFERENCES "public"."places"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_smart_device_id_smart_devices_id_fk" FOREIGN KEY ("smart_device_id") REFERENCES "public"."smart_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_signals" ADD CONSTRAINT "device_signals_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_connections" ADD CONSTRAINT "smart_connections_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_connections" ADD CONSTRAINT "smart_connections_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_connections" ADD CONSTRAINT "smart_connections_property_profile_id_property_profiles_id_fk" FOREIGN KEY ("property_profile_id") REFERENCES "public"."property_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_devices" ADD CONSTRAINT "smart_devices_smart_connection_id_smart_connections_id_fk" FOREIGN KEY ("smart_connection_id") REFERENCES "public"."smart_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_devices" ADD CONSTRAINT "smart_devices_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "smart_devices" ADD CONSTRAINT "smart_devices_property_profile_id_property_profiles_id_fk" FOREIGN KEY ("property_profile_id") REFERENCES "public"."property_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_credits" ADD CONSTRAINT "travel_credits_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_credits" ADD CONSTRAINT "travel_credits_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_credits" ADD CONSTRAINT "travel_credits_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "travel_credits" ADD CONSTRAINT "travel_credits_source_segment_id_trip_segments_id_fk" FOREIGN KEY ("source_segment_id") REFERENCES "public"."trip_segments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_segments" ADD CONSTRAINT "trip_segments_trip_id_trips_id_fk" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trip_segments" ADD CONSTRAINT "trip_segments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trips" ADD CONSTRAINT "trips_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pet_profiles_owner_idx" ON "pet_profiles" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "pet_vaccinations_pet_idx" ON "pet_vaccinations" USING btree ("pet_profile_id");--> statement-breakpoint
CREATE INDEX "pet_vaccinations_expiration_idx" ON "pet_vaccinations" USING btree ("expiration_date_sort");--> statement-breakpoint
CREATE INDEX "refill_reminders_pet_idx" ON "refill_reminders" USING btree ("pet_profile_id");--> statement-breakpoint
CREATE INDEX "refill_reminders_next_date_idx" ON "refill_reminders" USING btree ("next_refill_date_sort");--> statement-breakpoint
CREATE INDEX "context_rules_owner_idx" ON "context_rules" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "context_rules_geofence_idx" ON "context_rules" USING btree ("geofence_id");--> statement-breakpoint
CREATE INDEX "geofence_events_owner_idx" ON "geofence_events" USING btree ("owner_user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "geofences_owner_idx" ON "geofences" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "geofences_place_idx" ON "geofences" USING btree ("place_id");--> statement-breakpoint
CREATE INDEX "places_owner_idx" ON "places" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "travel_estimates_owner_idx" ON "travel_estimates" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "device_signals_device_idx" ON "device_signals" USING btree ("smart_device_id");--> statement-breakpoint
CREATE INDEX "device_signals_dedupe_idx" ON "device_signals" USING btree ("owner_user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "smart_connections_owner_idx" ON "smart_connections" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "smart_devices_connection_idx" ON "smart_devices" USING btree ("smart_connection_id");--> statement-breakpoint
CREATE INDEX "travel_credits_owner_idx" ON "travel_credits" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "travel_credits_expiration_idx" ON "travel_credits" USING btree ("expiration_date_sort");--> statement-breakpoint
CREATE INDEX "trip_segments_trip_idx" ON "trip_segments" USING btree ("trip_id");--> statement-breakpoint
CREATE INDEX "trip_segments_owner_start_idx" ON "trip_segments" USING btree ("owner_user_id","start_at_sort");--> statement-breakpoint
CREATE INDEX "trips_owner_idx" ON "trips" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "trips_start_idx" ON "trips" USING btree ("start_date_sort");--> statement-breakpoint
ALTER TABLE "maintenance_records" ADD CONSTRAINT "maintenance_records_pet_profile_id_pet_profiles_id_fk" FOREIGN KEY ("pet_profile_id") REFERENCES "public"."pet_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_pet_profile_id_pet_profiles_id_fk" FOREIGN KEY ("pet_profile_id") REFERENCES "public"."pet_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_records_pet_idx" ON "maintenance_records" USING btree ("pet_profile_id");--> statement-breakpoint
CREATE INDEX "bills_pet_idx" ON "bills" USING btree ("pet_profile_id");--> statement-breakpoint
CREATE INDEX "documents_expires_at_idx" ON "documents" USING btree ("expires_at_sort");