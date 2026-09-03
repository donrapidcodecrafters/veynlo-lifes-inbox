CREATE TABLE "batch_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"action_kind" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_ids" jsonb NOT NULL,
	"affected_count" integer NOT NULL,
	"outcome" text NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deep_link_routes" (
	"id" text PRIMARY KEY NOT NULL,
	"route_kind" text NOT NULL,
	"resource_type" text,
	"web_path_template" text NOT NULL,
	"requires_auth" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deep_link_routes_route_kind_unique" UNIQUE("route_kind")
);
--> statement-breakpoint
CREATE TABLE "desktop_device_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"notifications_enabled" boolean DEFAULT true NOT NULL,
	"quick_capture_shortcut" text DEFAULT 'CmdOrCtrl+Shift+I' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "local_cache_manifest" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"device_id" text NOT NULL,
	"cache_size_limit_bytes" integer,
	"cached_item_count" integer,
	"last_refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "batch_actions" ADD CONSTRAINT "batch_actions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "desktop_device_settings" ADD CONSTRAINT "desktop_device_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_cache_manifest" ADD CONSTRAINT "local_cache_manifest_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "batch_actions_user_idx" ON "batch_actions" USING btree ("user_id","performed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "desktop_device_settings_user_device_idx" ON "desktop_device_settings" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "local_cache_manifest_user_device_idx" ON "local_cache_manifest" USING btree ("user_id","device_id");