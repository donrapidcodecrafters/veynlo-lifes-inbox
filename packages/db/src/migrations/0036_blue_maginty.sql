CREATE TYPE "public"."memory_category" AS ENUM('product', 'place', 'recipe', 'article', 'movie_show', 'gift_idea', 'event', 'trip_idea', 'how_to', 'reference', 'document', 'generic');--> statement-breakpoint
CREATE TYPE "public"."memory_classification_state" AS ENUM('pending', 'classified', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."memory_source_kind" AS ENUM('link', 'screenshot', 'image', 'text', 'document', 'place', 'product', 'recipe', 'event', 'video', 'note');--> statement-breakpoint
CREATE TYPE "public"."resurfacing_rule_trigger" AS ENUM('date', 'person_birthday', 'trip_location');--> statement-breakpoint
CREATE TABLE "resurfacing_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"saved_memory_id" text NOT NULL,
	"trigger_type" "resurfacing_rule_trigger" NOT NULL,
	"trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"source_kind" "memory_source_kind" NOT NULL,
	"source_url" text,
	"source_document_id" text,
	"raw_text" text,
	"title" text,
	"user_notes" text,
	"category" "memory_category",
	"category_confidence" real,
	"extracted_fields" text NOT NULL,
	"related_person_label" text,
	"classification_state" "memory_classification_state" DEFAULT 'pending' NOT NULL,
	"classification_error" text,
	"content_hash" text,
	"pinned" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"never_resurface" boolean DEFAULT false NOT NULL,
	"auto_archive_at" timestamp with time zone,
	"not_useful_at" timestamp with time zone,
	"promoted_entity_type" text,
	"promoted_entity_id" text,
	"last_resurfaced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "warranties" ADD COLUMN "home_asset_id" text;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "smart_list_query" jsonb;--> statement-breakpoint
ALTER TABLE "resurfacing_rules" ADD CONSTRAINT "resurfacing_rules_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resurfacing_rules" ADD CONSTRAINT "resurfacing_rules_saved_memory_id_saved_memories_id_fk" FOREIGN KEY ("saved_memory_id") REFERENCES "public"."saved_memories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_memories" ADD CONSTRAINT "saved_memories_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_memories" ADD CONSTRAINT "saved_memories_source_document_id_documents_id_fk" FOREIGN KEY ("source_document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "resurfacing_rules_owner_idx" ON "resurfacing_rules" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "resurfacing_rules_memory_idx" ON "resurfacing_rules" USING btree ("saved_memory_id");--> statement-breakpoint
CREATE INDEX "saved_memories_owner_idx" ON "saved_memories" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "saved_memories_owner_category_idx" ON "saved_memories" USING btree ("owner_user_id","category");--> statement-breakpoint
CREATE INDEX "saved_memories_owner_hash_idx" ON "saved_memories" USING btree ("owner_user_id","content_hash");--> statement-breakpoint
ALTER TABLE "warranties" ADD CONSTRAINT "warranties_home_asset_id_home_assets_id_fk" FOREIGN KEY ("home_asset_id") REFERENCES "public"."home_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "warranties_home_asset_idx" ON "warranties" USING btree ("home_asset_id");