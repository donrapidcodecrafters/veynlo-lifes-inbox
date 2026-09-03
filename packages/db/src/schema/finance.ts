import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { connections } from "./connectors";
import { purchases, bills, returnCases } from "./commerce";
import { encryptedText } from "./encrypted-type";

/**
 * Phase 2 §52.2 "financial aggregator" (spec §Connections, feasibility class D — "Plaid-style partner
 * abstracting many institutions"). One `connections` row (provider: "plaid") represents one Plaid Item
 * (roughly: one bank login); a single Item can expose several accounts, hence the separate table here
 * rather than folding account fields onto `connections` itself.
 */
export const financialAccounts = pgTable(
  "financial_accounts",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plaidAccountId: text("plaid_account_id").notNull(),
    name: encryptedText("name").notNull(),
    officialName: encryptedText("official_name"),
    type: text("type").notNull(), // Plaid's AccountType: depository | credit | loan | investment | other
    subtype: text("subtype"),
    mask: text("mask"), // last 2-4 digits — not sensitive enough on its own to need encryption, same posture as documents' mimeType
    currentBalanceMinorUnits: integer("current_balance_minor_units"),
    availableBalanceMinorUnits: integer("available_balance_minor_units"),
    currency: text("currency").notNull().default("USD"),
    // FIN-001 "account list allows per-account inclusion/exclusion" — a real gap found via spec-conformance
    // audit: this column didn't exist at all, so a user had no way to exclude e.g. a shared/joint account
    // they don't want counted toward totals while still keeping it connected (visible, just not summed).
    // Nullable-in-spirit-but-not-in-schema: defaults true (every existing/new account starts included, the
    // only sane default — nothing should silently vanish from a summary the moment this column is added).
    isIncluded: boolean("is_included").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("financial_accounts_owner_idx").on(t.ownerUserId), index("financial_accounts_connection_idx").on(t.connectionId)],
);

export const financialTransactions = pgTable(
  "financial_transactions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    name: encryptedText("name").notNull(), // Plaid's raw transaction description, e.g. "AMAZON.COM*A1B2C"
    merchantName: encryptedText("merchant_name"),
    amountMinorUnits: integer("amount_minor_units").notNull(), // Plaid convention: positive = money out
    currency: text("currency").notNull().default("USD"),
    category: jsonb("category").$type<string[]>().notNull().default([]),
    pending: boolean("pending").notNull().default(false),
    postedDate: text("posted_date"), // YYYY-MM-DD, Plaid's own date-only convention for this field
    // Matching against evidence the ingestion pipeline already filed from email/document receipts —
    // §52.2's "financial aggregator" value is confirming/reconciling what was already found, not a second
    // independent source of truth. Left unmatched (both null) is a normal, common state, not an error.
    matchedPurchaseId: text("matched_purchase_id").references(() => purchases.id, { onDelete: "set null" }),
    matchedBillId: text("matched_bill_id").references(() => bills.id, { onDelete: "set null" }),
    // RET-003 "detect whether promised refund actually arrived" — a real gap found via spec-conformance
    // audit: `return_cases.refundObservedTransactionId` was reserved in the schema but nothing ever wrote
    // to it (no financial_transactions side to record the match from, mirroring matchedBillId/
    // paymentObservedTransactionId's existing two-sided pattern).
    matchedReturnCaseId: text("matched_return_case_id").references(() => returnCases.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("financial_transactions_owner_idx").on(t.ownerUserId),
    index("financial_transactions_account_idx").on(t.accountId),
    index("financial_transactions_plaid_id_idx").on(t.plaidTransactionId),
  ],
);

/**
 * FIN-003 "Model paycheck and recurring expenses as expected streams" — a real gap found via
 * spec-conformance audit: zero code existed to detect an income/deposit pattern from
 * `financial_transactions`. `FinanceService.detectIncomeStreams` recomputes candidates from raw
 * transactions on every call (never trusts stale state) and upserts here purely to give a detected
 * stream a STABLE identity across scans — the only thing that actually needs persisting is
 * `dismissedAt` (so a user's "not income" correction survives the next scan) and `firstDetectedAt`
 * (so the UI doesn't imply a stream was just discovered on every request).
 */
export const detectedIncomeStreams = pgTable(
  "detected_income_streams",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id")
      .notNull()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    // Stable dedup key this stream was last recomputed under (normalized transaction name/merchant,
    // lowercased/trimmed — see FinanceService's own `normalizeDescription`). Not itself sensitive
    // (already derivable from the plaintext `description` column below), so left unencrypted purely so
    // it can be used in a SQL equality lookup/unique index the way encrypted columns can't be.
    streamKey: text("stream_key").notNull(),
    description: encryptedText("description").notNull(),
    cadence: text("cadence").notNull(), // "weekly" | "biweekly" | "semimonthly" | "monthly"
    averageAmountMinorUnits: integer("average_amount_minor_units").notNull(),
    currency: text("currency").notNull().default("USD"),
    occurrenceCount: integer("occurrence_count").notNull(),
    lastOccurrenceDate: text("last_occurrence_date"), // YYYY-MM-DD, mirrors financialTransactions.postedDate
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("detected_income_streams_owner_idx").on(t.ownerUserId),
    index("detected_income_streams_account_stream_idx").on(t.accountId, t.streamKey),
  ],
);

/**
 * FIN-005 "Track credit-card minimum/due date, loan/mortgage details" — a real gap found via
 * spec-conformance audit: no table existed at all for liability fields (`financial_accounts` only ever
 * carried balances). One row per account (Plaid's liabilities endpoints key everything off account_id
 * too — AccountBase.account_id on CreditCardLiability/StudentLoan/MortgageLiability), upserted by
 * `PlaidAdapter.syncLiabilities` whenever a real Plaid `/liabilities/get` response includes data for
 * that account; left absent (no row) for an account Plaid doesn't report liability data for, which the UI
 * treats as "nothing to show" rather than an error.
 */
export const liabilities = pgTable(
  "liabilities",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .unique()
      .references(() => financialAccounts.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    minimumPaymentMinorUnits: integer("minimum_payment_minor_units"),
    dueDate: text("due_date"), // YYYY-MM-DD, Plaid's own date-only convention (next_payment_due_date)
    aprBasisPoints: integer("apr_basis_points"), // e.g. 2199 == 21.99% — avoids storing APR as a lossy float
    lastStatementBalanceMinorUnits: integer("last_statement_balance_minor_units"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("liabilities_owner_idx").on(t.ownerUserId)],
);

/**
 * FIN-002 "Avoid showing pending+posted as duplicates; preserve provider transaction ID history and
 * transaction revisions" — a real gap found via spec-conformance audit: `PlaidAdapter.upsertTransaction`
 * silently overwrote `financial_transactions` on every sync with no trail at all, so the spec's two named
 * edge cases (§19.1 "transaction ID mutation, pending amount change") both lost history silently:
 *
 * 1. "Pending amount change" — a bank posts a transaction as `pending` with an estimated amount, then
 *    finalizes it later with a different amount/date/pending-status but the SAME `plaidTransactionId`.
 *    `upsertTransaction` matches this row and would `.update(...).set(values)` straight over the old state.
 * 2. "Transaction ID mutation" — Plaid's own documented behavior where a pending transaction gets a brand
 *    new `transaction_id` once it posts (surfaced via the posted transaction's `pending_transaction_id`
 *    field). Left unhandled, the old row would show up in `/transactions/sync`'s `removed` list and get
 *    hard-deleted while an entirely disconnected new row took its place — silently severing
 *    `matchedPurchaseId`/`matchedBillId`/`matchedReturnCaseId` links and losing the fact these two IDs were
 *    ever the same real-world charge.
 *
 * One row is written immediately BEFORE either mutation, snapshotting the state about to be
 * overwritten/replaced — written only when something material actually changed (see
 * `PlaidAdapter.hasMaterialTransactionChange`), never for a no-op re-sync of identical values.
 * `financialTransactionId` is deliberately a plain, unconstrained column (mirrors `audit_events.resourceId`
 * exactly) rather than an FK with cascade delete: a "removed" revision is captured for a row that's about to
 * be hard-deleted, and a cascade would destroy the very history this table exists to keep.
 */
export const transactionRevisions = pgTable(
  "transaction_revisions",
  {
    id: text("id").primaryKey(),
    financialTransactionId: text("financial_transaction_id").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    // Snapshot of the PRE-mutation state — the values that were about to be overwritten/replaced/deleted,
    // not the new ones. amountMinorUnits/pending/postedDate are never encrypted on financialTransactions
    // either (only name/merchantName are — see that table's own columns), so the same posture applies here.
    plaidTransactionId: text("plaid_transaction_id").notNull(),
    amountMinorUnits: integer("amount_minor_units").notNull(),
    pending: boolean("pending").notNull(),
    postedDate: text("posted_date"),
    // "pending_amount_changed" | "id_mutated" | "removed" — why this snapshot was captured, so a revision
    // history view can explain itself rather than just showing raw before/after values.
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transaction_revisions_transaction_idx").on(t.financialTransactionId),
    index("transaction_revisions_owner_idx").on(t.ownerUserId),
  ],
);
