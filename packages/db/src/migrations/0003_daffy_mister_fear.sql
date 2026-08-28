-- Several columns move from jsonb to text as part of adding application-level field encryption
-- (§SEC-ROW — see packages/db/src/crypto/field-encryption.ts). A plain jsonb->text cast preserves the OLD
-- PLAINTEXT bytes as a text string rather than encrypting them, so this migration does NOT attempt to
-- carry existing row data through — pre-launch, there's no real user data to preserve. `pnpm db:migrate`
-- followed by `pnpm db:seed` gives a clean, correctly-encrypted-from-birth dataset. A real production
-- rollout of this change after real user data exists would need a proper backfill script (decrypt nothing,
-- since old data isn't encrypted yet — just read each plaintext row, encrypt it via the app's own
-- encryptField(), write it back) run before/alongside this migration, not a bare SQL cast.
ALTER TABLE "canonical_entities" ALTER COLUMN "aliases" SET DATA TYPE text USING '[]'::text;--> statement-breakpoint
ALTER TABLE "canonical_entities" ALTER COLUMN "aliases" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "facts" ALTER COLUMN "value_json" SET DATA TYPE text USING NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tags" SET DATA TYPE text USING '[]'::text;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "tags" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "inbox_items" ALTER COLUMN "suggested_actions" SET DATA TYPE text USING '[]'::text;--> statement-breakpoint
ALTER TABLE "inbox_items" ALTER COLUMN "suggested_actions" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "commands_json" SET DATA TYPE text USING NULL;--> statement-breakpoint
ALTER TABLE "automation_runs" ALTER COLUMN "result_json" SET DATA TYPE text USING NULL;--> statement-breakpoint
ALTER TABLE "billing_events" ALTER COLUMN "payload_json" SET DATA TYPE text USING NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "before_json" SET DATA TYPE text USING NULL;--> statement-breakpoint
ALTER TABLE "audit_events" ALTER COLUMN "after_json" SET DATA TYPE text USING NULL;--> statement-breakpoint
ALTER TABLE "extraction_runs" ALTER COLUMN "output_json" SET DATA TYPE text USING NULL;
