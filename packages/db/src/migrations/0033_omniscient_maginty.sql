CREATE TYPE "public"."permission_form_state" AS ENUM('discovered', 'opened', 'completed', 'submitted', 'confirmed');--> statement-breakpoint
CREATE TYPE "public"."school_source_kind" AS ENUM('ics', 'forwarding_email');--> statement-breakpoint
CREATE TABLE "permission_forms" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"school_id" text,
	"dependent_id" text,
	"school_event_id" text,
	"title" text NOT NULL,
	"state" "permission_form_state" DEFAULT 'discovered' NOT NULL,
	"due_date" jsonb,
	"due_date_sort" timestamp with time zone,
	"source_event_id" text,
	"confidence_band" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "school_events" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"school_id" text,
	"school_source_id" text,
	"dependent_id" text,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"start" jsonb NOT NULL,
	"start_sort" timestamp with time zone,
	"is_all_day" boolean DEFAULT true NOT NULL,
	"location" text,
	"arrival_note" text,
	"requires_dropoff" boolean DEFAULT false NOT NULL,
	"requires_pickup" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'discovered_from_evidence' NOT NULL,
	"provider_event_id" text,
	"source_event_id" text,
	"confidence_band" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "school_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"school_id" text,
	"created_by_user_id" text NOT NULL,
	"label" text NOT NULL,
	"kind" "school_source_kind" DEFAULT 'ics' NOT NULL,
	"ics_url" text,
	"health" text DEFAULT 'initializing' NOT NULL,
	"health_detail" text,
	"last_successful_sync_at" timestamp with time zone,
	"items_discovered_count" integer DEFAULT 0 NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schools" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "permission_forms" ADD CONSTRAINT "permission_forms_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_forms" ADD CONSTRAINT "permission_forms_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_forms" ADD CONSTRAINT "permission_forms_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_forms" ADD CONSTRAINT "permission_forms_dependent_id_dependent_profiles_id_fk" FOREIGN KEY ("dependent_id") REFERENCES "public"."dependent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "permission_forms" ADD CONSTRAINT "permission_forms_school_event_id_school_events_id_fk" FOREIGN KEY ("school_event_id") REFERENCES "public"."school_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_school_source_id_school_sources_id_fk" FOREIGN KEY ("school_source_id") REFERENCES "public"."school_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_events" ADD CONSTRAINT "school_events_dependent_id_dependent_profiles_id_fk" FOREIGN KEY ("dependent_id") REFERENCES "public"."dependent_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_sources" ADD CONSTRAINT "school_sources_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_sources" ADD CONSTRAINT "school_sources_school_id_schools_id_fk" FOREIGN KEY ("school_id") REFERENCES "public"."schools"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "school_sources" ADD CONSTRAINT "school_sources_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schools" ADD CONSTRAINT "schools_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "permission_forms_household_due_idx" ON "permission_forms" USING btree ("household_id","due_date_sort");--> statement-breakpoint
CREATE INDEX "permission_forms_dependent_idx" ON "permission_forms" USING btree ("dependent_id");--> statement-breakpoint
CREATE INDEX "school_events_household_start_idx" ON "school_events" USING btree ("household_id","start_sort");--> statement-breakpoint
CREATE INDEX "school_events_dependent_idx" ON "school_events" USING btree ("dependent_id");--> statement-breakpoint
CREATE INDEX "school_events_source_provider_idx" ON "school_events" USING btree ("school_source_id","provider_event_id");--> statement-breakpoint
CREATE INDEX "school_sources_household_idx" ON "school_sources" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "schools_household_idx" ON "schools" USING btree ("household_id");