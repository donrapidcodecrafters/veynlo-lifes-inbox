-- search_documents.owner_user_id was the ONE owner_user_id column in the schema with no foreign key to
-- users. Account deletion works by `DELETE FROM users` and letting the cascading foreign keys carry
-- everything else away (worker-main.ts's accountDeletionWorker) — so these rows simply stayed behind.
--
-- Proven against a real database before writing this: delete a user, and their pet_profiles row is gone
-- while their search_documents row remains with `title` and `body_text` intact. And this is the worst table
-- for it: those two columns are deliberately PLAINTEXT — that is the entire purpose of the index, since the
-- source columns are encrypted and cannot be searched — so a deleted account left behind a plaintext,
-- full-text-searchable copy of its own content, indefinitely.
--
-- The DELETE below removes rows whose owner no longer exists. It is not incidental cleanup to make the
-- constraint apply: it is the erasure that should have happened when those accounts were deleted. Nothing
-- recoverable is lost — every row for a user who still exists can be rebuilt at any time by
-- `pnpm --filter @veynlo/api run backfill-search-documents`, and the rows this removes are precisely the
-- ones that backfill could never recreate, because there is no owner left to rebuild them from.
DELETE FROM "search_documents" sd WHERE NOT EXISTS (SELECT 1 FROM "users" u WHERE u.id = sd.owner_user_id);
--> statement-breakpoint
ALTER TABLE "search_documents" ADD CONSTRAINT "search_documents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
