-- TASK-003: recurrence_rule was a free-text column that no application code ever read or expanded
-- (confirmed via grep before this pass) — this dev database nonetheless has a few rows with legacy
-- ad-hoc RRULE-style strings (e.g. "FREQ=WEEKLY...") left over from earlier manual testing, which aren't
-- valid JSON and can't be losslessly reinterpreted as the new structured RecurrenceRule shape (there's no
-- reliable mapping from an arbitrary RRULE string to this app's narrower rule vocabulary). Since nothing
-- ever consumed those values, discarding the unparseable ones (NULL) rather than failing the whole
-- migration is the right call — any row that already happens to hold valid JSON is preserved as-is.
ALTER TABLE "calendar_events" ALTER COLUMN "recurrence_rule" SET DATA TYPE jsonb
  USING (CASE WHEN recurrence_rule IS NOT NULL AND recurrence_rule ~ '^\s*[\{\[]' THEN recurrence_rule::jsonb ELSE NULL END);--> statement-breakpoint
ALTER TABLE "tasks" ALTER COLUMN "recurrence_rule" SET DATA TYPE jsonb
  USING (CASE WHEN recurrence_rule IS NOT NULL AND recurrence_rule ~ '^\s*[\{\[]' THEN recurrence_rule::jsonb ELSE NULL END);