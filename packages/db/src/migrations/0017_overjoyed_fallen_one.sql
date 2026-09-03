ALTER TABLE "household_memberships" ADD COLUMN "invite_token_hash" text;--> statement-breakpoint
ALTER TABLE "household_memberships" ADD COLUMN "invite_token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
UPDATE "shipments" s SET "owner_user_id" = p."owner_user_id" FROM "purchases" p WHERE s."purchase_id" = p."id" AND s."owner_user_id" IS NULL;--> statement-breakpoint
UPDATE "shipments" s SET "owner_user_id" = p."owner_user_id" FROM "return_cases" rc JOIN "purchases" p ON p."id" = rc."purchase_id" WHERE s."return_case_id" = rc."id" AND s."owner_user_id" IS NULL;--> statement-breakpoint
-- Pre-launch app, never deployed (see docs/DECISIONS.md) — any shipment row with neither a purchase nor a
-- return case link has no owner to backfill from and is dev/seed noise, not real user data to preserve.
DELETE FROM "shipments" WHERE "owner_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipments_owner_tracking_idx" ON "shipments" USING btree ("owner_user_id","tracking_number");--> statement-breakpoint
ALTER TABLE "household_memberships" ADD CONSTRAINT "household_memberships_invite_token_hash_unique" UNIQUE("invite_token_hash");
