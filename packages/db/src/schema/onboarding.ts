import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * ONB-001 "value-first onboarding" — one row per user, created at sign-up, tracking progress through
 * the goal -> recommended connector -> consent -> history depth -> scan -> first-value wizard so a user
 * who navigates away mid-flow resumes at the same step instead of restarting. A user with no row here
 * predates this feature and is treated as already onboarded (see OnboardingService.getState) — this
 * table intentionally never backfills historical accounts.
 */
export const onboardingState = pgTable("onboarding_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  goal: text("goal"),
  step: text("step").notNull().default("goals"),
  recommendedProvider: text("recommended_provider"),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  skippedAt: timestamp("skipped_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
