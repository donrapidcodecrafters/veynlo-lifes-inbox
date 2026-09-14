ALTER TABLE "legacy_release_configs" ADD COLUMN "release_expires_at" timestamp with time zone;
--> statement-breakpoint
-- Existing finalized releases would otherwise keep a NULL expiry, which is precisely the unbounded link
-- this column exists to end. Backfill them to the same window a new release gets, measured from when they
-- were actually released, so the rule applies to the rows that already have it wrong rather than only to
-- rows created from now on. `released_at` is always set alongside status='released' (see
-- LegacyReleaseService.finalizeRelease), and COALESCE guards the theoretical row where it is not.
UPDATE "legacy_release_configs"
SET "release_expires_at" = COALESCE("released_at", now()) + interval '365 days'
WHERE "status" = 'released' AND "release_expires_at" IS NULL;
