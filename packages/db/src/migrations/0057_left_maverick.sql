CREATE TABLE "access_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"access_method" text NOT NULL,
	"accessed_by_user_id" text,
	"resource_grant_id" text,
	"share_link_id" text,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "caregiver_day_passes" (
	"id" text PRIMARY KEY NOT NULL,
	"household_id" text NOT NULL,
	"created_by_user_id" text NOT NULL,
	"label" text NOT NULL,
	"token_hash" text NOT NULL,
	"passcode_hash" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "caregiver_day_passes_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "legacy_release_configs" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"trusted_contact_email" text NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"waiting_period_days" integer NOT NULL,
	"inactivity_threshold_days" integer,
	"status" text DEFAULT 'draft' NOT NULL,
	"confirmed_at" timestamp with time zone,
	"release_initiated_by_admin_id" text,
	"release_initiated_at" timestamp with time zone,
	"release_eligible_at" timestamp with time zone,
	"release_finalized_by_admin_id" text,
	"released_at" timestamp with time zone,
	"release_token_hash" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "legacy_release_configs_release_token_hash_unique" UNIQUE("release_token_hash")
);
--> statement-breakpoint
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_accessed_by_user_id_users_id_fk" FOREIGN KEY ("accessed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_resource_grant_id_resource_grants_id_fk" FOREIGN KEY ("resource_grant_id") REFERENCES "public"."resource_grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_audit_events" ADD CONSTRAINT "access_audit_events_share_link_id_share_links_id_fk" FOREIGN KEY ("share_link_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_day_passes" ADD CONSTRAINT "caregiver_day_passes_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "caregiver_day_passes" ADD CONSTRAINT "caregiver_day_passes_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_release_configs" ADD CONSTRAINT "legacy_release_configs_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_release_configs" ADD CONSTRAINT "legacy_release_configs_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_audit_events_resource_idx" ON "access_audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE INDEX "access_audit_events_accessed_at_idx" ON "access_audit_events" USING btree ("accessed_at");--> statement-breakpoint
CREATE INDEX "caregiver_day_passes_household_idx" ON "caregiver_day_passes" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "legacy_release_configs_owner_idx" ON "legacy_release_configs" USING btree ("owner_user_id");