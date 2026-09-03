CREATE TABLE "identity_records" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"record_type" text NOT NULL,
	"label" text NOT NULL,
	"issuing_authority" text,
	"document_number" text,
	"issued_date" jsonb,
	"expiration_date" jsonb,
	"expiration_date_sort" timestamp with time zone,
	"linked_vehicle_id" text,
	"linked_property_id" text,
	"linked_document_id" text,
	"jurisdiction" text,
	"renewal_url" text,
	"reminder_lead_days" integer DEFAULT 60 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"superseded_by_record_id" text,
	"sensitivity" "sensitivity_tier" DEFAULT 'highly_sensitive' NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "jurisdiction_renewal_links" (
	"id" text PRIMARY KEY NOT NULL,
	"record_type" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"owner_user_id" text,
	"url" text NOT NULL,
	"label" text NOT NULL,
	"source_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_intent_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"platform" text NOT NULL,
	"intent_kind" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"outcome" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"widget_kind" text NOT NULL,
	"privacy_mode" text DEFAULT 'detail' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identity_records" ADD CONSTRAINT "identity_records_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_records" ADD CONSTRAINT "identity_records_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_records" ADD CONSTRAINT "identity_records_linked_vehicle_id_vehicle_profiles_id_fk" FOREIGN KEY ("linked_vehicle_id") REFERENCES "public"."vehicle_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_records" ADD CONSTRAINT "identity_records_linked_property_id_property_profiles_id_fk" FOREIGN KEY ("linked_property_id") REFERENCES "public"."property_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_records" ADD CONSTRAINT "identity_records_linked_document_id_documents_id_fk" FOREIGN KEY ("linked_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jurisdiction_renewal_links" ADD CONSTRAINT "jurisdiction_renewal_links_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_intent_log" ADD CONSTRAINT "app_intent_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_preferences" ADD CONSTRAINT "widget_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_records_owner_idx" ON "identity_records" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "identity_records_expiration_idx" ON "identity_records" USING btree ("expiration_date_sort");--> statement-breakpoint
CREATE INDEX "identity_records_household_idx" ON "identity_records" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "jurisdiction_renewal_links_lookup_idx" ON "jurisdiction_renewal_links" USING btree ("record_type","jurisdiction");--> statement-breakpoint
CREATE INDEX "jurisdiction_renewal_links_owner_idx" ON "jurisdiction_renewal_links" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "app_intent_log_user_idx" ON "app_intent_log" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "widget_preferences_user_kind_idx" ON "widget_preferences" USING btree ("user_id","widget_kind");