import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedJsonb } from "./encrypted-type";

export const entitlements = pgTable("entitlements", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
  planKey: text("plan_key").notNull(),
  source: text("source").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  gracePeriodEndsAt: timestamp("grace_period_ends_at", { withTimezone: true }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Normalized ledger of raw store/processor billing events, source-of-truth reconciliation input (§46.2). */
export const billingEvents = pgTable(
  "billing_events",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // "app_store" | "play_store" | "web_stripe"
    externalEventId: text("external_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: encryptedJsonb<unknown>("payload_json", null).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Stripe (and every other processor) documents that the same webhook event can be delivered more than
  // once — BillingService.handleWebhook/RevenueCatService.handleWebhook both check this table for an
  // existing row before applying side effects; the unique index is what makes that check race-safe
  // against two near-simultaneous redeliveries, not just correct in the common sequential-retry case.
  (t) => [uniqueIndex("billing_events_source_external_id_idx").on(t.source, t.externalEventId)],
);
