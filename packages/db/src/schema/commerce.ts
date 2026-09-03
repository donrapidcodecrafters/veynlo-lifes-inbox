import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { canonicalEntities } from "./graph";
import { adminUsers } from "./admin";
import { encryptedText } from "./encrypted-type";
import { propertyProfiles, vehicleProfiles, petProfiles, homeAssets } from "./assets";
import { healthAppointments } from "./health";

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
  /** Same "repoint exactly these back on unmerge" reasoning as repointedPurchaseIds above, extended to the
   * other two tables that carry a merchantId FK — storeCredits and recurringStreams. A merge that only
   * repointed purchases silently orphaned a merged-away merchant's store credits/recurring streams under
   * the old merchant id, which is still a live row (just excluded from listMerchants), so those rows didn't
   * error, they just stopped showing up anywhere the surviving merchant's lineage is consulted (e.g. the
   * merchant detail view) — found while auditing this merge path for exactly this gap. */
  repointedStoreCreditIds: jsonb("repointed_store_credit_ids").$type<string[]>().notNull().default([]),
  repointedRecurringStreamIds: jsonb("repointed_recurring_stream_ids").$type<string[]>().notNull().default([]),
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
  // `onDelete: "set null"` matters as of the graph write path actually populating `canonical_entities`
  // (see ingestion.service.ts's extractReceipt): without it, deleting a user cascades into both
  // `purchases`→`purchase_lines` and `canonical_entities` in the same statement, and this FK (having no
  // ON DELETE action) blocks that cascade with a constraint violation whenever a referencing purchase
  // line still exists — silently stranding the account in "deletion_pending" forever. The worker that
  // deletes a single connection's derived data already works around this by deleting in careful manual
  // order (see worker-main.ts's connectionDataDeletionWorker doc comment); full account deletion had no
  // such workaround and was actually broken by this until now.
  ownerAssetEntityId: text("owner_asset_entity_id").references(() => canonicalEntities.id, { onDelete: "set null" }),
  giftFlag: boolean("gift_flag").notNull().default(false),
  /**
   * RET-006 "Resale handoff" — the one piece of state this deliberately scoped-down feature actually
   * tracks: "not_listed" | "listed" | "sold". No buyer/transaction/price-sold tracking (a real marketplace
   * feature this app correctly doesn't need to replicate) — see this session's docs/PHASE2_PENDING_CREDENTIALS.md
   * entry for why there's no real eBay/Facebook Marketplace/Craigslist API integration here at all, only a
   * generated listing draft handed off via the platform's native share sheet. The listing draft itself
   * (title/description/condition) is deliberately NOT persisted — it's cheaply re-derived from
   * productLabel/merchant/purchaseDate each time the resale panel opens, with condition editable in the
   * moment before sharing, so this one column is the only schema surface the feature needs.
   */
  resaleStatus: text("resale_status").notNull().default("not_listed"),
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

export const shipments = pgTable("shipments", {
  id: text("id").primaryKey(),
  // Carrier tracking numbers aren't globally unique across different owners (and purchaseId/returnCaseId
  // are both nullable — a shipment can arrive with no matched order), so ownership must live directly on
  // this row rather than only being reachable through a join. findExistingShipment scopes its dedup lookup
  // by this column; before it existed, two different owners' shipments sharing a tracking number could
  // silently overwrite each other's row.
  ownerUserId: text("owner_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
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
}, (t) => [index("shipments_owner_tracking_idx").on(t.ownerUserId, t.trackingNumber)]);

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
    // PET-005 "insurance/service history" — lets a vet bill or pet-insurance premium bill resolve to "this
    // pet," the same optional-linkage pattern `warranties.propertyProfileId`/`vehicleProfileId` already
    // uses, reused here rather than a parallel pet-billing system. Nullable/independent of every other bill.
    petProfileId: text("pet_profile_id").references(() => petProfiles.id, { onDelete: "set null" }),
    // HLTH-004 "medical bill/EOB organizer" — links a medical bill to the appointment/provider it's for,
    // the same optional-linkage pattern as petProfileId/warranties.propertyProfileId above. Nullable/
    // independent of every other bill; only ever set via HealthLogisticsService.linkBillToAppointment
    // (owner-only, both rows must already belong to the same caller).
    healthAppointmentId: text("health_appointment_id").references(() => healthAppointments.id, { onDelete: "set null" }),
    // HLTH-004 "Highlight mismatched amounts only as 'review' unless deterministic source facts confirm
    // discrepancy" — never inferred; set only when linking two distinct bills to the same
    // healthAppointmentId whose amountDueMinorUnits literally disagree (see
    // HealthLogisticsService.linkBillToAppointment). Purely a UI flag — no bill is ever auto-corrected or
    // auto-marked as an error from this.
    needsAmountReview: boolean("needs_amount_review").notNull().default(false),
    // Encrypted — note this is read via raw SQL in TimelineService, which bypasses the customType's
    // transparent decryption; that service manually decrypts it after the query (see timeline.service.ts).
    billerLabel: encryptedText("biller_label").notNull(),
    // UTIL-001 "Track electric, gas, water, sewer, trash, internet, mobile, cable/satellite and security
    // bills" — a coarse heuristic classification of `billerLabel` (see
    // services/api/src/modules/commerce/biller-category.ts's `categorizeBiller`), set once at extraction
    // time and never overwritten by a later email for the same bill (a biller's category doesn't change
    // bill to bill). Null when the heuristic doesn't recognize the name — never guessed at, since a wrong
    // category would misfile a non-utility bill (e.g. a gym membership) into the utility baseline/rollup
    // views. Plain text, not an enum: the fixed value set ("electric"|"gas"|"water"|"sewer"|"trash"|
    // "internet"|"mobile"|"cable"|"security") lives in application code (categorizeBiller's own return
    // type), matching purchases.state/confidenceBand's existing "text column, code-enforced values"
    // convention elsewhere in this same table rather than a DB-level enum migration for a value set that
    // may still grow.
    billerCategory: text("biller_category"),
    amountDueMinorUnits: integer("amount_due_minor_units"),
    amountDueCurrency: text("amount_due_currency"),
    dueDate: jsonb("due_date").$type<TemporalValue>().notNull(),
    dueDateSort: timestamp("due_date_sort", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    autopayBelieved: boolean("autopay_believed"),
    paymentObservedTransactionId: encryptedText("payment_observed_transaction_id"),
    // UTIL-001 "equipment return obligations ... from source messages where available" — explicit-only,
    // never inferred: IngestionService.extractBill's system prompt instructs the model to leave this null
    // unless the email literally states a hardware-return deadline (e.g. "return your modem within 14 days
    // of cancellation or be charged $75"). Mirrors returnCases.deadline/warranties.expirationDate's own
    // TemporalValue-plus-sort-column shape so AttentionService.scanAndFileDeadlines can pick it up the same
    // way it already does for every other deadline type in this file.
    equipmentReturnDeadline: jsonb("equipment_return_deadline").$type<TemporalValue>(),
    equipmentReturnDeadlineSort: timestamp("equipment_return_deadline_sort", { withTimezone: true }),
    // Encrypted — the literal return instructions/address quoted from the source email, shown verbatim on
    // the bill-detail page rather than re-derived, since paraphrasing a shipping address or RMA number
    // would risk introducing an error a user then ships equipment to.
    equipmentReturnInstructions: encryptedText("equipment_return_instructions"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("bills_due_date_idx").on(t.dueDateSort),
    index("bills_pet_idx").on(t.petProfileId),
    index("bills_equipment_return_idx").on(t.equipmentReturnDeadlineSort),
  ],
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
    // Phase 2 §52.2 "service/warranty/maintenance history" — lets "this water heater's warranty" resolve
    // to "this house" once a property/vehicle profile exists; both nullable and independent (a warranty
    // for a laptop belongs to neither), never both set for one row (enforced in application code, not a
    // DB constraint — see assets.ts's maintenanceRecords doc comment for why).
    propertyProfileId: text("property_profile_id").references(() => propertyProfiles.id, { onDelete: "set null" }),
    vehicleProfileId: text("vehicle_profile_id").references(() => vehicleProfiles.id, { onDelete: "set null" }),
    // HOMEOS-008 "link homeAssets to existing warranties rows rather than duplicating" — a discrete home
    // asset (a specific refrigerator) is a narrower subject than the whole property, so this is independent
    // of `propertyProfileId` above (a warranty can name the asset without also naming the property, though
    // in practice UI flows set both since a home asset always belongs to one).
    homeAssetId: text("home_asset_id").references(() => homeAssets.id, { onDelete: "set null" }),
    // Encrypted — note this is read via raw SQL in TimelineService, which bypasses the customType's
    // transparent decryption; that service manually decrypts it after the query (see timeline.service.ts).
    productLabel: encryptedText("product_label").notNull(),
    warrantyLengthMonths: integer("warranty_length_months"),
    expirationDate: jsonb("expiration_date").$type<TemporalValue>().notNull(),
    expirationDateSort: timestamp("expiration_date_sort", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    registrationConfirmed: boolean("registration_confirmed"),
    // Set automatically by CommerceService.resolveReturn when the return case being resolved has a
    // deterministic `purchaseLineId` (not just "same purchase" — see resolveReturn's own comment on why
    // that's the bar) matching this warranty's `purchaseLineId`: the underlying product was actually
    // returned, so the warranty covering it almost certainly no longer applies. Deliberately never cleared
    // automatically (no code path un-voids a warranty) — if a return is itself reversed that's a rare
    // enough edge case for a human to sort out directly, same "only a human decides the discrepancy is
    // resolved" posture as HealthLogisticsService.clearBillAmountReview.
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("warranties_expiration_date_idx").on(t.expirationDateSort), index("warranties_home_asset_idx").on(t.homeAssetId)],
);

/**
 * Phase 2 §52.2 "advanced returns/refunds/store credits" — a genuinely new fact type; nothing in the
 * ingestion pipeline wrote to anything like this before (a store credit is neither a purchase, a return,
 * nor a bill — it's a balance owed BY a merchant TO the user, the inverse of a bill). `sourceReturnCaseId`
 * links back to the return that generated it when known (most common path: "we can't refund your card, so
 * here's a $45 credit"), but is nullable since a credit can also come from a promotion/goodwill gesture
 * with no return behind it at all.
 */
export const storeCredits = pgTable(
  "store_credits",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    merchantId: text("merchant_id").references(() => merchants.id),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    expirationDate: jsonb("expiration_date").$type<TemporalValue>(),
    expirationDateSort: timestamp("expiration_date_sort", { withTimezone: true }),
    sourceReturnCaseId: text("source_return_case_id").references(() => returnCases.id, { onDelete: "set null" }),
    sourceEventId: text("source_event_id"),
    redeemed: boolean("redeemed").notNull().default(false),
    redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
    confidenceBand: text("confidence_band"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("store_credits_owner_idx").on(t.ownerUserId), index("store_credits_expiration_idx").on(t.expirationDateSort)],
);

export const priceObservations = pgTable("price_observations", {
  id: text("id").primaryKey(),
  subjectEntityId: text("subject_entity_id").notNull(),
  observedAmountMinorUnits: integer("observed_amount_minor_units").notNull(),
  observedAmountCurrency: text("observed_amount_currency").notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  sourceEventId: text("source_event_id").notNull(),
});

/**
 * SUB-004 "Cancellation assistant ... shows known steps ... when a direct API/partner flow doesn't exist" —
 * a small, RET-004/jurisdiction_links-shaped curated reference table of ordered plain-text cancellation
 * steps, keyed by merchant. See packages/db/src/seed/merchant-cancellation-steps.ts for the actual seeded
 * rows and that file's own sourcing discipline: only a handful of genuinely well-known, currently-accurate
 * public cancellation processes — never a live scrape/fetch, never invented steps for a merchant nobody on
 * this team has verified. `ownerUserId` null = a global seeded fact visible to everyone; set = one user's
 * own correction/addition for that merchant — same precedence rule as `merchantPriceAdjustmentPolicies`/
 * `jurisdictionRenewalLinks` (see services/api/src/modules/commerce/merchant-cancellation-steps.ts's own
 * doc comment): a user's own row always outranks the global seeded one, never the reverse. This is
 * deliberately just a reference table of STEPS TO FOLLOW, not any kind of direct-cancel API/partner
 * integration — no such business relationship exists for this app to build against.
 */
export const merchantCancellationSteps = pgTable(
  "merchant_cancellation_steps",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    /** Null = a global reference fact visible to every user; set = one user's private correction/addition. */
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Ordered plain-text steps, e.g. ["Log into your account", "Go to Settings > Subscription", "Click Cancel Plan"]. */
    steps: jsonb("steps").$type<string[]>().notNull(),
    /** Free-text citation of where this fact came from — mirrors merchantPriceAdjustmentPolicies.sourceNote, including honest caveats about how confident/stable this process is. */
    sourceNote: text("source_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchant_cancellation_steps_merchant_idx").on(t.merchantId),
    index("merchant_cancellation_steps_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * RET-004 "Price-adjustment opportunity" policy engine — see
 * services/api/src/modules/commerce/price-adjustment-policy.ts for the resolution algorithm this table
 * backs (confidence precedence, effective-dated rows, the flat-30-day fallback when no row matches), and
 * that file's own doc comment for the full design rationale (global seeded facts vs. a per-user
 * correction, never mutated in place).
 */
export const merchantPriceAdjustmentPolicies = pgTable(
  "merchant_price_adjustment_policies",
  {
    id: text("id").primaryKey(),
    merchantId: text("merchant_id")
      .notNull()
      .references(() => merchants.id),
    /** Null = a global reference fact visible to every user; set = one user's private correction. */
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    windowDays: integer("window_days").notNull(),
    /** "user_confirmed" | "commonly_known" | "assumed" — see PriceAdjustmentPolicyConfidence in price-adjustment-policy.ts. */
    confidence: text("confidence").notNull(),
    /** Free-text citation of where this fact came from — a URL, "per Target's published Price Match Guarantee", or a user's own note. */
    sourceNote: text("source_note"),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("merchant_price_adjustment_policies_merchant_idx").on(t.merchantId),
    index("merchant_price_adjustment_policies_owner_idx").on(t.ownerUserId),
  ],
);
