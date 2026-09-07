-- Deep-link target columns for push notifications.
--
-- Tapping any push notification used to cold-launch the app to the generic Home tab regardless of what
-- the notification was about, because the target resource is not recoverable from the notification row:
-- `dedupe_key` follows a "<category>:<resource-id>" convention that carries the id but never the TYPE,
-- and the attention scanner (AttentionService.notifyIfUrgent) never set `linked_attention_item_id`, so
-- there was nothing to join back to either. AttentionItem already knows both, so they are stored here at
-- enqueue time instead of making the device reverse-engineer a route from ~25 reason codes.
--
-- Nullable on purpose: the daily/weekly briefs genuinely have no single target resource and correctly
-- open Home.
ALTER TABLE "notifications" ADD COLUMN "linked_resource_type" text;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "linked_resource_id" text;

-- NOTE ON WHAT WAS REMOVED FROM THIS FILE
--
-- `drizzle-kit generate` also emitted a full CREATE TABLE for "object_notes", its foreign key and its
-- index. That is not a real pending change: 0065_restore_object_notes.sql already creates that table.
-- 0065 was written BY HAND (it restores a table lost in the 2026-09-03 force-push) and hand-written
-- migrations do not update drizzle's snapshot chain, so meta/ jumped 0064 -> 0066 and the generator
-- believed object_notes still did not exist.
--
-- Left in, those statements would fail on every database that has already applied 0065 — including the
-- dev database and CI — with "relation \"object_notes\" already exists". 0065 guards its own DDL with
-- IF NOT EXISTS; the generated copy had no such guard.
--
-- The 0066 snapshot DOES include object_notes, so the chain is consistent from here on and a future
-- generate will not re-emit it. Same class of problem as 0047, and handled the same way: keep the file
-- (drizzle-kit chains meta/*_snapshot.json by prevId, so deleting it would break the chain) and strip
-- only the statements that were never a real change.
