ALTER TABLE "shipments" ADD COLUMN "owner_user_id" text;--> statement-breakpoint
ALTER TABLE "shipments" ADD COLUMN "household_id" text;--> statement-breakpoint
UPDATE "shipments" s SET "owner_user_id" = p."owner_user_id" FROM "purchases" p WHERE p."id" = s."purchase_id" AND s."owner_user_id" IS NULL;--> statement-breakpoint
UPDATE "shipments" s SET "owner_user_id" = i."owner_user_id" FROM "inbox_items" i WHERE i."linked_resource_type" = 'shipment' AND i."linked_resource_id" = s."id" AND s."owner_user_id" IS NULL;--> statement-breakpoint
DELETE FROM "shipments" WHERE "owner_user_id" IS NULL;--> statement-breakpoint
ALTER TABLE "shipments" ALTER COLUMN "owner_user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "shipments_owner_tracking_idx" ON "shipments" USING btree ("owner_user_id","tracking_number");
