ALTER TABLE "users" ADD COLUMN "inbound_email_alias" text;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_inbound_email_alias_unique" UNIQUE("inbound_email_alias");