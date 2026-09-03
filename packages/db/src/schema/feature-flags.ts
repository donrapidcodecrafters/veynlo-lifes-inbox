import { pgTable, text, boolean, timestamp } from "drizzle-orm/pg-core";

/**
 * A genuine remote kill switch, not a targeting/experimentation system — one global on/off per key,
 * flippable from the admin console without an app release. First real use: the Android notification-
 * listener message-capture feature, which needs to be disable-able instantly if Google Play objects to
 * it after a review, without waiting on an app-store update cycle.
 */
export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  description: text("description").notNull(),
  // §47.4/§39.2 "budget guardrails ... configurable" — most flags are pure on/off (`enabled` alone is the
  // whole story), but a few (e.g. the historical-backfill cost-pressure pause) need an admin-tunable NUMBER
  // alongside the bool — a per-user cost cap, not just "is the cap active." Rather than a second table for
  // the rare flag that needs one, this reuses the exact same admin-flippable, no-app-release mechanism:
  // `value` is null for every ordinary boolean-only flag (see FeatureFlagsService.getNumericValue for the
  // read side).
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
