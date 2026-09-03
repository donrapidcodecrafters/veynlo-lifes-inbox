CREATE TABLE "aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contact_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"provider" text NOT NULL,
	"connection_id" text,
	"provider_contact_id" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"name" text NOT NULL,
	"organization_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"display_name" text NOT NULL,
	"organization_id" text,
	"relationship_label" text,
	"relationship_label_source" text DEFAULT 'user_set' NOT NULL,
	"is_important" boolean DEFAULT false NOT NULL,
	"last_contact_at" timestamp with time zone,
	"related_entity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sensitivity" "sensitivity_tier" DEFAULT 'sensitive' NOT NULL,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"merged_into_person_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_important_dates" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"label" text NOT NULL,
	"date" jsonb NOT NULL,
	"date_sort" timestamp with time zone,
	"is_sensitive" boolean DEFAULT false NOT NULL,
	"reminder_days_before" integer DEFAULT 14 NOT NULL,
	"last_reminded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_merge_lineage" (
	"id" text PRIMARY KEY NOT NULL,
	"surviving_person_id" text NOT NULL,
	"merged_person_id" text NOT NULL,
	"merged_person_snapshot" jsonb NOT NULL,
	"repointed_contact_source_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_alias_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_note_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_important_date_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"repointed_relationship_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actor_user_id" text NOT NULL,
	"merged_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unmerged_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "person_relationships" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"from_person_id" text NOT NULL,
	"to_person_id" text,
	"to_dependent_profile_id" text,
	"label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "aliases" ADD CONSTRAINT "aliases_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sources" ADD CONSTRAINT "contact_sources_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sources" ADD CONSTRAINT "contact_sources_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_sources" ADD CONSTRAINT "contact_sources_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_important_dates" ADD CONSTRAINT "person_important_dates_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_important_dates" ADD CONSTRAINT "person_important_dates_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merge_lineage" ADD CONSTRAINT "person_merge_lineage_surviving_person_id_people_id_fk" FOREIGN KEY ("surviving_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merge_lineage" ADD CONSTRAINT "person_merge_lineage_merged_person_id_people_id_fk" FOREIGN KEY ("merged_person_id") REFERENCES "public"."people"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merge_lineage" ADD CONSTRAINT "person_merge_lineage_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_notes" ADD CONSTRAINT "person_notes_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_from_person_id_people_id_fk" FOREIGN KEY ("from_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_to_person_id_people_id_fk" FOREIGN KEY ("to_person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_relationships" ADD CONSTRAINT "person_relationships_to_dependent_profile_id_dependent_profiles_id_fk" FOREIGN KEY ("to_dependent_profile_id") REFERENCES "public"."dependent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "aliases_person_idx" ON "aliases" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "aliases_owner_idx" ON "aliases" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "contact_sources_person_idx" ON "contact_sources" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "contact_sources_owner_provider_idx" ON "contact_sources" USING btree ("owner_user_id","provider");--> statement-breakpoint
CREATE INDEX "organizations_owner_idx" ON "organizations" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "people_owner_idx" ON "people" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "people_household_idx" ON "people" USING btree ("household_id");--> statement-breakpoint
CREATE INDEX "people_organization_idx" ON "people" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "person_important_dates_person_idx" ON "person_important_dates" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_important_dates_date_sort_idx" ON "person_important_dates" USING btree ("date_sort");--> statement-breakpoint
CREATE INDEX "person_merge_lineage_surviving_idx" ON "person_merge_lineage" USING btree ("surviving_person_id");--> statement-breakpoint
CREATE INDEX "person_notes_person_idx" ON "person_notes" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "person_relationships_from_idx" ON "person_relationships" USING btree ("from_person_id");--> statement-breakpoint
CREATE INDEX "person_relationships_to_person_idx" ON "person_relationships" USING btree ("to_person_id");