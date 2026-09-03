import { pgTable, text, timestamp, pgEnum, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { connections } from "./connectors";

/**
 * ONB-001/ONB-002 "value-first onboarding" — one row per user, created at sign-up (see
 * IdentityService.signUp/findOrCreateOAuthUser). Deliberately a dedicated table rather than a bare
 * `users.onboardingCompletedAt` timestamp: the flow has multiple resumable stages (goal → pre-permission →
 * connect → historical depth → scan → discovery review → household invite), and a returning user who
 * refreshes or signs back in mid-flow needs to resume at `currentStep`, not just know whether they
 * "finished" — a single boolean can't carry that. Absence of a row (pre-existing accounts created before
 * this feature shipped) is read by OnboardingService as "onboarding not applicable" rather than "not
 * started", so this never retroactively traps an existing user in a first-run flow they never had.
 */
export const onboardingStepEnum = pgEnum("onboarding_step", [
  "goal_selection",
  "pre_permission",
  "connecting",
  "historical_depth",
  "scanning",
  "discovery_review",
  "household_invite",
  "completed",
]);

export const onboardingGoalEnum = pgEnum("onboarding_goal", [
  "important_dates",
  "purchases_returns",
  "bills_subscriptions",
  "family",
  "travel",
  "things_i_own",
]);

/** Mirrors ONB-002's own named options ("Forward only, 30 days, 90 days, 6 months, 1 year, or 'build my
 * history'"), stored as the user's *choice* — the actual enforced day count is resolved at connect time by
 * EntitlementsService.resolveHistoricalBackfillDays, which clamps this choice to the plan's cap. */
export const onboardingHistoryDepthEnum = pgEnum("onboarding_history_depth", [
  "forward_only",
  "days_30",
  "days_90",
  "months_6",
  "year_1",
  "build_history",
]);

export const onboardingState = pgTable(
  "onboarding_state",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: "cascade" }),
    currentStep: onboardingStepEnum("current_step").notNull().default("goal_selection"),
    goal: onboardingGoalEnum("goal"),
    // "gmail" | "outlook" | "plaid" | "household" | "manual_asset" — see onboarding.service.ts's
    // GOAL_RECOMMENDATIONS lookup table. Plain text, not an enum: this is a UI hint, not a foreign key,
    // and new connector recommendations shouldn't require a migration.
    recommendedConnector: text("recommended_connector"),
    historyDepthChoice: onboardingHistoryDepthEnum("history_depth_choice"),
    // The connection created for the bounded first-run scan (if the user connected the recommended
    // source). Progress is read live off `connections.health`/`itemsDiscoveredCount` and a count of
    // `inbox_items` created since `scanStartedAt` — no separate progress-tracking table.
    scanConnectionId: text("scan_connection_id").references(() => connections.id, { onDelete: "set null" }),
    scanStartedAt: timestamp("scan_started_at", { withTimezone: true }),
    // Set the first time the "invite household later" step is shown and answered (connect now or defer) —
    // read by OnboardingService so it's offered at most once, not every time onboarding is resumed.
    householdInviteOfferedAt: timestamp("household_invite_offered_at", { withTimezone: true }),
    skippedAt: timestamp("skipped_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("onboarding_state_user_idx").on(t.userId)],
);
