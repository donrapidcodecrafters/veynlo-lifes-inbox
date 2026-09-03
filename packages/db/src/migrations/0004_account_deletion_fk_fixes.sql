ALTER TABLE "caregiver_delegations" DROP CONSTRAINT "caregiver_delegations_granted_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "resource_grants" DROP CONSTRAINT "resource_grants_granted_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "share_links" DROP CONSTRAINT "share_links_created_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "entity_merge_lineage" DROP CONSTRAINT "entity_merge_lineage_actor_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "automation_runs" DROP CONSTRAINT "automation_runs_approved_by_user_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "caregiver_delegations" ADD CONSTRAINT "caregiver_delegations_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_grants" ADD CONSTRAINT "resource_grants_granted_by_user_id_users_id_fk" FOREIGN KEY ("granted_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_links" ADD CONSTRAINT "share_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_merge_lineage" ADD CONSTRAINT "entity_merge_lineage_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;