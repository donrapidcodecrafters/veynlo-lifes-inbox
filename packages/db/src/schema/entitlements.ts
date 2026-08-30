import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedJsonb } from "./encrypted-type";

export const entitlements = pgTable(
  "entitlements",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    planKey: text("plan_key").notNull(),
    source: text("source").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    // No local grace-period timer by design — both Stripe (invoice.payment_failed) and RevenueCat
    // (BILLING_ISSUE) already run their own retry schedule before a real terminal event (canceled/unpaid,
    // EXPIRATION) fires; see BillingService/RevenueCatService's payment-failure handlers. A second,
    // locally-computed grace-period clock would just race against the processor's own and had no reader
    // or writer anywhere in the codebase — removed rather than left as a misleading unused column.
    effectiveTo: timestamp("effective_to", { withTimezone: true }),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // Read on nearly every plan-gated request (every /v1/ask, upload, connect) -- the single hottest lookup path in the app.
  (t) => [index("entitlements_user_idx").on(t.userId)],
);

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
    payloadJson: encryptedJsonb<unknown>("payload_json").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // A replayed webhook (Stripe/RevenueCat both retry on anything but a 2xx) must not double-process —
  // this was previously unconstrained, so a retried delivery could double-insert an entitlement.
  (t) => [uniqueIndex("billing_events_source_external_event_idx").on(t.source, t.externalEventId)],
);
