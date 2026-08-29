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
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
