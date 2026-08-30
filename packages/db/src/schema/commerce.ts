import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { canonicalEntities } from "./graph";
import { adminUsers } from "./admin";
import { encryptedText } from "./encrypted-type";

export const merchants = pgTable("merchants", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(), // findOrCreateMerchant looks this up by exact match; also global/shared reference data, not owner-private
  domain: text("domain"),
  logoUrl: text("logo_url"),
  /** Set when an admin merges this merchant into another (see merchantMergeLineage) — the row stays queryable/undoable rather than being hard-deleted. */
  mergedIntoMerchantId: text("merged_into_merchant_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Merchants are a global, shared reference table (not owner-scoped like
 * canonical_entities), so duplicate merchants — "Amazon.com" vs. "Amazon"
 * vs. "AMAZON MKTPLACE PMTS" from different email templates, since
 * findOrCreateMerchant matches by exact display-name string — are a
 * support/admin data-quality operation, not a per-user one. Deliberately a
 * dedicated table rather than reusing entity_merge_lineage, which hard-FKs
 * to canonical_entities (an owner-scoped, currently-unwritten table) and
 * has different semantics (confidence score, algorithm version) that don't
 * fit a human-initiated admin merge.
 */
export const merchantMergeLineage = pgTable("merchant_merge_lineage", {
  id: text("id").primaryKey(),
  survivingMerchantId: text("surviving_merchant_id")
    .notNull()
    .references(() => merchants.id),
  mergedMerchantId: text("merged_merchant_id")
    .notNull()
    .references(() => merchants.id),
  /** Full pre-merge row, so unmerge can restore it exactly rather than reconstructing a guess. */
  mergedMerchantSnapshot: jsonb("merged_merchant_snapshot").notNull(),
  /** Purchase IDs repointed by this merge, so unmerge repoints exactly those back rather than every purchase currently on the surviving merchant (which may include ones legitimately added after the merge). */
  repointedPurchaseIds: jsonb("repointed_purchase_ids").$type<string[]>().notNull().default([]),
  actorAdminId: text("actor_admin_id")
    .notNull()
    .references(() => adminUsers.id),
  mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
  unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
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
    orderNumber: text("order_number"), // dedup lookup key — see purchases_order_number_idx and findExistingPurchase
    purchaseDate: jsonb("purchase_date").$type<TemporalValue>().notNull(),
    /** Denormalized sortable instant derived from purchaseDate for range queries; nullable when precision is coarse. */
    purchaseDateSort: timestamp("purchase_date_sort", { withTimezone: true }),
    totalMinorUnits: integer("total_minor_units"),
    totalCurrency: text("total_currency"),
    taxMinorUnits: integer("tax_minor_units"),
    shippingMinorUnits: integer("shipping_minor_units"),
    paymentMethodHint: encryptedText("payment_method_hint"),
    state: text("state").notNull().default("candidate"),
    confidenceBand: text("confidence_band").notNull(),
    sourceEventId: text("source_event_id"),
    // PEO-004 "person linkage" — same generic link-to-any-resource pattern as documents.linkedEntityIds,
    // reused rather than a dedicated join table; always manually added (nothing infers "this purchase was
    // for Jane" from evidence today).
    linkedEntityIds: jsonb("linked_entity_ids").$type<string[]>().notNull().default([]),
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
  productLabel: encryptedText("product_label").notNull(),
  productMatchEntityId: text("product_match_entity_id").references(() => canonicalEntities.id),
  quantity: integer("quantity").notNull().default(1),
  unitPriceMinorUnits: integer("unit_price_minor_units"),
  lineTotalMinorUnits: integer("line_total_minor_units"),
  currency: text("currency"),
  serialNumber: encryptedText("serial_number"),
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
    trackingNumber: encryptedText("tracking_number"),
    refundExpectedBy: jsonb("refund_expected_by").$type<TemporalValue>(),
    refundObservedTransactionId: encryptedText("refund_observed_transaction_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("return_cases_deadline_idx").on(t.deadlineSort)],
);

export const shipments = pgTable(
  "shipments",
  {
    id: text("id").primaryKey(),
    // Added after a real cross-tenant bug: findExistingShipment previously matched on trackingNumber
    // ALONE, with no owner scoping, so two different users' packages sharing a tracking number (not rare
    // — many small carriers/resellers reuse number ranges) would silently collide onto the same row. Every
    // other domain table scopes dedup by ownerUserId first; shipments was the one exception.
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    purchaseId: text("purchase_id").references(() => purchases.id, { onDelete: "cascade" }),
    returnCaseId: text("return_case_id").references(() => returnCases.id, { onDelete: "cascade" }),
    carrier: text("carrier").notNull(),
    trackingNumber: text("tracking_number").notNull(), // dedup lookup key — see findExistingShipment
    status: text("status").notNull().default("label_created"),
    confidenceBand: text("confidence_band"),
    estimatedDelivery: jsonb("estimated_delivery").$type<TemporalValue>(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    isGiftPrivate: boolean("is_gift_private").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("shipments_owner_tracking_idx").on(t.ownerUserId, t.trackingNumber)],
);

export const recurringStreams = pgTable("recurring_streams", {
  id: text("id").primaryKey(),
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
  merchantId: text("merchant_id").references(() => merchants.id),
  serviceLabel: encryptedText("service_label").notNull(),
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
  confidenceBand: text("confidence_band"),
  trialEndsAt: jsonb("trial_ends_at").$type<TemporalValue>(),
  cancellationInstructionsUrl: encryptedText("cancellation_instructions_url"),
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
    // Encrypted — note this is read via raw SQL in TimelineService, which bypasses the customType's
    // transparent decryption; that service manually decrypts it after the query (see timeline.service.ts).
    billerLabel: encryptedText("biller_label").notNull(),
    amountDueMinorUnits: integer("amount_due_minor_units"),
    amountDueCurrency: text("amount_due_currency"),
    dueDate: jsonb("due_date").$type<TemporalValue>().notNull(),
    dueDateSort: timestamp("due_date_sort", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    autopayBelieved: boolean("autopay_believed"),
    paymentObservedTransactionId: encryptedText("payment_observed_transaction_id"),
    // PEO-004 "person linkage" — see purchases.linkedEntityIds' comment.
    linkedEntityIds: jsonb("linked_entity_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("bills_due_date_idx").on(t.dueDateSort), index("bills_owner_idx").on(t.ownerUserId)],
);

export const warranties = pgTable(
  "warranties",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    purchaseLineId: text("purchase_line_id").references(() => purchaseLines.id, { onDelete: "set null" }),
    // Encrypted — note this is read via raw SQL in TimelineService, which bypasses the customType's
    // transparent decryption; that service manually decrypts it after the query (see timeline.service.ts).
    productLabel: encryptedText("product_label").notNull(),
    warrantyLengthMonths: integer("warranty_length_months"),
    expirationDate: jsonb("expiration_date").$type<TemporalValue>().notNull(),
    expirationDateSort: timestamp("expiration_date_sort", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    registrationConfirmed: boolean("registration_confirmed"),
    // PEO-004 "person linkage" — see purchases.linkedEntityIds' comment.
    linkedEntityIds: jsonb("linked_entity_ids").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("warranties_expiration_date_idx").on(t.expirationDateSort), index("warranties_owner_idx").on(t.ownerUserId)],
);

export const priceObservations = pgTable("price_observations", {
  id: text("id").primaryKey(),
  subjectEntityId: text("subject_entity_id").notNull(),
  observedAmountMinorUnits: integer("observed_amount_minor_units").notNull(),
  observedAmountCurrency: text("observed_amount_currency").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  sourceEventId: text("source_event_id").notNull(),
});
