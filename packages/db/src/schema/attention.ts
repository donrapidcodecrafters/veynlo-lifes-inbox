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
    suggestedActions: encryptedJsonb<string[]>("suggested_actions").notNull().default([]),
    autoFiled: boolean("auto_filed").notNull().default(false),
    // INB-001 "Duplicates" filter — true when this item's extraction matched an already-tracked resource
    // (the same MAIL-003 thread-aware update-in-place logic in IngestionService) rather than filing a
    // brand-new one. Distinct from a literal re-ingested duplicate email, which never reaches this table
    // at all (blocked earlier by source_events.idempotencyKey).
    isDuplicate: boolean("is_duplicate").notNull().default(false),
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
    // HOME-001 snooze/delegate actions — same column names/shapes as tasks.snoozedUntil/assignedToUserId
    // for consistency, though that table's own columns are a separate, still-unwired gap (see ROADMAP).
    snoozedUntil: timestamp("snoozed_until", { withTimezone: true }),
    assignedToUserId: text("assigned_to_user_id").references(() => users.id, { onDelete: "set null" }),
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
    // §54.2 launch criteria — the key `notificationPreferences.categoryOverrides` is keyed by (e.g.
    // "bill", "purchase", "daily_brief"); null means the sender didn't attribute a category (e.g. an
    // ad-hoc system notice), which never gets suppressed by a category override.
    category: text("category"),
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
});
