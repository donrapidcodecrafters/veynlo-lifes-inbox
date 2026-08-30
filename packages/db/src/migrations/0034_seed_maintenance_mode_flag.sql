-- Custom SQL migration file, put your code below! --

-- Seeds the global emergency read-only mode flag so it's immediately visible/toggleable in the admin
-- console flags list (which only lists existing rows) without a manual API call first, in every
-- environment. Starts disabled. Idempotent -- safe to re-run.
INSERT INTO "feature_flags" ("key", "enabled", "description")
VALUES ('maintenance_mode', false, 'Global emergency read-only mode. When enabled, blocks all mutating (non-GET) requests except /v1/admin/* and the billing webhook endpoints. Use to freeze writes during an incident without taking the API down.')
ON CONFLICT ("key") DO NOTHING;