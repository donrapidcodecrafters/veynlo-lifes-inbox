import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedText, encryptedJsonb } from "./encrypted-type";

export const inboxItems = pgTable(
  "inbox_items",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    category: text("category").notNull(),
    summary: encryptedText("summary").notNull(),
    linkedResourceType: text("linked_resource_type"),
    linkedResourceId: text("linked_resource_id"),
    sourceEventId: text("source_event_id").notNull(),
    suggestedActions: encryptedJsonb<string[]>("suggested_actions", []).notNull().default([]),
    autoFiled: boolean("auto_filed").notNull().default(false),
    reviewState: text("review_state").notNull().default("new"),
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    confidenceBand: text("confidence_band").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("inbox_items_owner_state_idx").on(t.ownerUserId, t.reviewState)],
);

export const attentionItems = pgTable(
  "attention_items",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    reasonCode: text("reason_code").notNull(),
    reasonText: encryptedText("reason_text").notNull(),
    urgency: text("urgency").notNull(),
    dueAt: jsonb("due_at").$type<TemporalValue>(),
    dueAtSort: timestamp("due_at_sort", { withTimezone: true }),
    moneyAtStakeMinorUnits: integer("money_at_stake_minor_units"),
    moneyAtStakeCurrency: text("money_at_stake_currency"),
    confidenceBand: text("confidence_band").notNull(),
    linkedResourceType: text("linked_resource_type"),
    linkedResourceId: text("linked_resource_id"),
    primaryActions: jsonb("primary_actions").$type<string[]>().notNull().default([]),
    resolved: boolean("resolved").notNull().default(false),
    dismissedReason: encryptedText("dismissed_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attention_items_owner_resolved_idx").on(t.ownerUserId, t.resolved, t.dueAtSort)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dedupeKey: text("dedupe_key").notNull(),
    priority: text("priority").notNull(),
    channel: text("channel").notNull(),
    title: encryptedText("title").notNull(),
    body: encryptedText("body").notNull(),
    linkedAttentionItemId: text("linked_attention_item_id"),
    state: text("state").notNull().default("queued"),
    suppressionReason: text("suppression_reason"),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    openedAt: timestamp("opened_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_dedupe_idx").on(t.ownerUserId, t.dedupeKey)],
);

export const notificationPreferences = pgTable("notification_preferences", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  intensity: text("intensity").notNull().default("balanced"),
  quietHoursStart: text("quiet_hours_start"),
  quietHoursEnd: text("quiet_hours_end"),
  categoryOverrides: jsonb("category_overrides").$type<Record<string, string>>().notNull().default({}),
  dailyBriefEnabled: boolean("daily_brief_enabled").notNull().default(true),
  weeklyBriefEnabled: boolean("weekly_brief_enabled").notNull().default(true),
  // §NOT-002 "Respect user quiet hours ... critical override only when user opted in and event qualifies"
  // — found live via a fresh audit: NotificationDeliveryService.deliver already bypassed quiet hours for
  // ANY "critical"-priority notification unconditionally, with no preference anywhere a user could opt out
  // of that override, contradicting the spec's explicit "only when user opted in" condition. Defaults true
  // (preserves the existing always-override behavior for every current user — same "don't silently change
  // behavior for existing users" reasoning as sensitivePreviewsEnabled just above) but now exists as a
  // real, user-controllable preference NotificationDeliveryService actually checks, rather than a rule
  // hardcoded with no off switch.
  criticalOverridesQuietHours: boolean("critical_overrides_quiet_hours").notNull().default(true),
  // §23 "Do not send private financial/document detail in email or lock-screen push unless the user
  // explicitly permits that preview level." Defaults true (preserves existing behavior — every brief/
  // discovery notification already includes real detail, and this isn't a live security bug today since
  // nothing currently sends via the "push" channel — see notification-dispatch.service.ts's doc comment)
  // rather than defaulting false, which would be a silent behavior change for every existing user. The
  // point is that the choice now exists and is enforced, not which way it defaults.
  sensitivePreviewsEnabled: boolean("sensitive_previews_enabled").notNull().default(true),
  // Phase 2 §52.2 "safe-spend awareness" (spec screen "065. Safe-spend settings" — the spec names the
  // screen but never describes its behavior beyond that). Null means no cap set: CommerceService's
  // monthly-spend summary is purely informational until a user opts into a threshold worth flagging.
  monthlySpendCapMinorUnits: integer("monthly_spend_cap_minor_units"),
  // AUTO-010 "Account and household settings can pause all external actions immediately" — non-null
  // means paused. Checked by AutomationService.evaluateEvent before any rule can even match, so a paused
  // account creates zero new runs (existing pending runs are untouched — pausing stops new automation,
  // it isn't a bulk-cancel of what's already queued for approval).
  automationsPausedAt: timestamp("automations_paused_at", { withTimezone: true }),
});
