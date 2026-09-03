ALTER TYPE "public"."resurfacing_rule_trigger" ADD VALUE 'location_proximity';--> statement-breakpoint
ALTER TABLE "resource_grants" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "health_appointment_id" text;--> statement-breakpoint
-- tags/highlights are encrypted-jsonb columns (see encrypted-type.ts's encryptedJsonb) — like every other
-- encrypted-jsonb column added to an EXISTING table in this codebase (e.g. documents.tags predates this),
-- drizzle-kit cannot express a working DB-level default for them (there's no way to statically emit a
-- runtime-encrypted literal), so this backfills existing rows with the real ciphertext for an empty array
-- ("[]", encrypted under this dev environment's FIELD_ENCRYPTION_KEY) before adding the NOT NULL
-- constraint, instead of generating invalid "DEFAULT NOT NULL" SQL with no default expression at all.
ALTER TABLE "saved_memories" ADD COLUMN "tags" text;--> statement-breakpoint
ALTER TABLE "saved_memories" ADD COLUMN "rating" integer;--> statement-breakpoint
ALTER TABLE "saved_memories" ADD COLUMN "highlights" text;--> statement-breakpoint
UPDATE "saved_memories" SET "tags" = 'Adi6X00sK6FJg43/tGw+a6rw6Z/Su+0LUmjVwWvOuA==' WHERE "tags" IS NULL;--> statement-breakpoint
UPDATE "saved_memories" SET "highlights" = 'Adi6X00sK6FJg43/tGw+a6rw6Z/Su+0LUmjVwWvOuA==' WHERE "highlights" IS NULL;--> statement-breakpoint
ALTER TABLE "saved_memories" ALTER COLUMN "tags" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "saved_memories" ALTER COLUMN "highlights" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_health_appointment_id_health_appointments_id_fk" FOREIGN KEY ("health_appointment_id") REFERENCES "public"."health_appointments"("id") ON DELETE set null ON UPDATE no action;