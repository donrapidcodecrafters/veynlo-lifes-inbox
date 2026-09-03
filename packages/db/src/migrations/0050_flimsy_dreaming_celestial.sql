ALTER TABLE "passkeys" ADD COLUMN "transports" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "device_type" text;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "backed_up" boolean;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "passkeys" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "biller_category" text;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "equipment_return_deadline" jsonb;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "equipment_return_deadline_sort" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "equipment_return_instructions" text;--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "bills_equipment_return_idx" ON "bills" USING btree ("equipment_return_deadline_sort");