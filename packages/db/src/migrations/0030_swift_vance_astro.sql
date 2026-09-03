CREATE TABLE "signup_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"email" text,
	"redeemed_at" timestamp with time zone,
	"redeemed_by_user_id" text,
	"created_by_admin_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "signup_invites_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "medications_notes" text;--> statement-breakpoint
ALTER TABLE "households" ADD COLUMN "emergency_instructions" text;--> statement-breakpoint
ALTER TABLE "signup_invites" ADD CONSTRAINT "signup_invites_redeemed_by_user_id_users_id_fk" FOREIGN KEY ("redeemed_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signup_invites" ADD CONSTRAINT "signup_invites_created_by_admin_id_admin_users_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admin_users"("id") ON DELETE cascade ON UPDATE no action;