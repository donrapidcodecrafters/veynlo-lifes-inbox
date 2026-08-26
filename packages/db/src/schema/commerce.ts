import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { canonicalEntities } from "./graph";

export const merchants = pgTable("merchants", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  domain: text("domain"),
  logoUrl: text("logo_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const purchases = pgTable(
  "purchases",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    merchantId: text("merchant_id").references(() => merchants.id),
    orderNumber: text("order_number"),
    purchaseDate: jsonb("purchase_date").$type<TemporalValue>().notNull(),
    /** Denormalized sortable instant derived from purchaseDate for range queries; nullable when precision is coarse. */
    purchaseDateSort: timestamp("purchase_date_sort", { withTimezone: true }),
    totalMinorUnits: integer("total_minor_units"),
    totalCurrency: text("total_currency"),
    taxMinorUnits: integer("tax_minor_units"),
    shippingMinorUnits: integer("shipping_minor_units"),
    paymentMethodHint: text("payment_method_hint"),
    state: text("state").notNull().default("candidate"),
    confidenceBand: text("confidence_band").notNull(),
    sourceEventId: text("source_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchases_owner_idx").on(t.ownerUserId),
    index("purchases_order_number_idx").on(t.merchantId, t.orderNumber),
  ],
);

export const purchaseLines = pgTable("purchase_lines", {
  id: text("id").primaryKey(),
  purchaseId: text("purchase_id")
    .notNull()
    .references(() => purchases.id, { onDelete: "cascade" }),
  productLabel: text("product_label").notNull(),
  productMatchEntityId: text("product_match_entity_id").references(() => canonicalEntities.id),
  quantity: integer("quantity").notNull().default(1),
  unitPriceMinorUnits: integer("unit_price_minor_units"),
  lineTotalMinorUnits: integer("line_total_minor_units"),
  currency: text("currency"),
  serialNumber: text("serial_number"),
  ownerAssetEntityId: text("owner_asset_entity_id").references(() => canonicalEntities.id),
  giftFlag: boolean("gift_flag").notNull().default(false),
});

export const returnCases = pgTable(
  "return_cases",
  {
    id: text("id").primaryKey(),
    purchaseId: text("purchase_id")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    purchaseLineId: text("purchase_line_id").references(() => purchaseLines.id),
    state: text("state").notNull().default("eligible"),
    deadline: jsonb("deadline").$type<TemporalValue>().notNull(),
    deadlineSort: timestamp("deadline_sort", { withTimezone: true }),
    valueAtStakeMinorUnits: integer("value_at_stake_minor_units"),
    valueAtStakeCurrency: text("value_at_stake_currency"),
    policyEvidenceId: text("policy_evidence_id"),
    trackingNumber: text("tracking_number"),
    refundExpectedBy: jsonb("refund_expected_by").$type<TemporalValue>(),
    refundObservedTransactionId: text("refund_observed_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("return_cases_deadline_idx").on(t.deadlineSort)],
);

export const shipments = pgTable("shipments", {
  id: text("id").primaryKey(),
  purchaseId: text("purchase_id").references(() => purchases.id, { onDelete: "cascade" }),
  returnCaseId: text("return_case_id").references(() => returnCases.id, { onDelete: "cascade" }),
  carrier: text("carrier").notNull(),
  trackingNumber: text("tracking_number").notNull(),
  status: text("status").notNull().default("label_created"),
  estimatedDelivery: jsonb("estimated_delivery").$type<TemporalValue>(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  isGiftPrivate: boolean("is_gift_private").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const recurringStreams = pgTable("recurring_streams", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
  merchantId: text("merchant_id").references(() => merchants.id),
  serviceLabel: text("service_label").notNull(),
  cadence: text("cadence").notNull(),
  typicalAmountMinorUnits: integer("typical_amount_minor_units"),
  typicalAmountCurrency: text("typical_amount_currency"),
  nextExpectedDate: jsonb("next_expected_date").$type<TemporalValue>(),
  essential: boolean("essential"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const subscriptions = pgTable("subscriptions", {
  id: text("id").primaryKey(),
  recurringStreamId: text("recurring_stream_id")
    .notNull()
    .references(() => recurringStreams.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("candidate"),
  trialEndsAt: jsonb("trial_ends_at").$type<TemporalValue>(),
  cancellationInstructionsUrl: text("cancellation_instructions_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const bills = pgTable(
  "bills",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    recurringStreamId: text("recurring_stream_id").references(() => recurringStreams.id, { onDelete: "set null" }),
    billerLabel: text("biller_label").notNull(),
    amountDueMinorUnits: integer("amount_due_minor_units"),
    amountDueCurrency: text("amount_due_currency"),
    dueDate: jsonb("due_date").$type<TemporalValue>().notNull(),
    dueDateSort: timestamp("due_date_sort", { withTimezone: true }),
    autopayBelieved: boolean("autopay_believed"),
    paymentObservedTransactionId: text("payment_observed_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bills_due_date_idx").on(t.dueDateSort)],
);

export const priceObservations = pgTable("price_observations", {
  id: text("id").primaryKey(),
  subjectEntityId: text("subject_entity_id").notNull(),
  observedAmountMinorUnits: integer("observed_amount_minor_units").notNull(),
  observedAmountCurrency: text("observed_amount_currency").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  sourceEventId: text("source_event_id").notNull(),
});
