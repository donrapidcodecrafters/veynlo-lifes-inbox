CREATE TABLE "health_appointments" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"household_id" text,
	"visibility" "visibility" DEFAULT 'private' NOT NULL,
	"provider_name" text,
	"appointment_type" text,
	"date_time" jsonb NOT NULL,
	"date_time_sort" timestamp with time zone,
	"location" text,
	"prep_instructions" text,
	"status" text DEFAULT 'confirmed' NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_event_id" text,
	"confidence_band" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pet_vaccinations" ALTER COLUMN "pet_profile_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pet_vaccinations" ADD COLUMN "household_id" text;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD COLUMN "dependent_profile_id" text;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD COLUMN "picked_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "health_appointment_id" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "needs_amount_review" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "health_appointments" ADD CONSTRAINT "health_appointments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "health_appointments" ADD CONSTRAINT "health_appointments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "health_appointments_owner_idx" ON "health_appointments" USING btree ("owner_user_id","date_time_sort");--> statement-breakpoint
ALTER TABLE "pet_vaccinations" ADD CONSTRAINT "pet_vaccinations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_reminders" ADD CONSTRAINT "refill_reminders_dependent_profile_id_dependent_profiles_id_fk" FOREIGN KEY ("dependent_profile_id") REFERENCES "public"."dependent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bills" ADD CONSTRAINT "bills_health_appointment_id_health_appointments_id_fk" FOREIGN KEY ("health_appointment_id") REFERENCES "public"."health_appointments"("id") ON DELETE set null ON UPDATE no action;