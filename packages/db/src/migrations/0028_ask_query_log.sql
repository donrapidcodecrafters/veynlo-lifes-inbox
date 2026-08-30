CREATE TABLE "ask_query_log" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ask_query_log" ADD CONSTRAINT "ask_query_log_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ask_query_log_owner_occurred_idx" ON "ask_query_log" USING btree ("owner_user_id","occurred_at");