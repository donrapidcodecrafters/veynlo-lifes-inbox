CREATE TYPE "public"."onboarding_goal" AS ENUM('important_dates', 'purchases_returns', 'bills_subscriptions', 'family', 'travel', 'things_i_own');--> statement-breakpoint
CREATE TYPE "public"."onboarding_history_depth" AS ENUM('forward_only', 'days_30', 'days_90', 'months_6', 'year_1', 'build_history');--> statement-breakpoint
CREATE TYPE "public"."onboarding_step" AS ENUM('goal_selection', 'pre_permission', 'connecting', 'historical_depth', 'scanning', 'discovery_review', 'household_invite', 'completed');--> statement-breakpoint
CREATE TABLE "category_preferences" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"domain" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "home_module_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"module_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"hidden_modules" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personalization_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"preferred_name" text,
	"week_start" text DEFAULT 'sunday' NOT NULL,
	"time_format" text DEFAULT '12h' NOT NULL,
	"ask_response_style" text DEFAULT 'balanced' NOT NULL,
	"suggestion_intensity" text DEFAULT 'balanced' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "onboarding_state" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"current_step" "onboarding_step" DEFAULT 'goal_selection' NOT NULL,
	"goal" "onboarding_goal",
	"recommended_connector" text,
	"history_depth_choice" "onboarding_history_depth",
	"scan_connection_id" text,
	"scan_started_at" timestamp with time zone,
	"household_invite_offered_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_state_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "category_preferences" ADD CONSTRAINT "category_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "home_module_preferences" ADD CONSTRAINT "home_module_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personalization_preferences" ADD CONSTRAINT "personalization_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "onboarding_state" ADD CONSTRAINT "onboarding_state_scan_connection_id_connections_id_fk" FOREIGN KEY ("scan_connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "category_preferences_user_domain_idx" ON "category_preferences" USING btree ("user_id","domain");--> statement-breakpoint
CREATE INDEX "category_preferences_user_idx" ON "category_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "onboarding_state_user_idx" ON "onboarding_state" USING btree ("user_id");