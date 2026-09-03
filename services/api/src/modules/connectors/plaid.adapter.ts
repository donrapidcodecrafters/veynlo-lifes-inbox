import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { ConnectorAdapter } from "./connector.interface";
import { plaidRequestError } from "./connection-health.util";

const MATCH_WINDOW_MS = 3 * 86_400_000; // ±3 days between a bank posting and the receipt/bill evidence date

interface PlaidCredentials {
  access_token: string;
  item_id: string;
}

interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balances: { current: number | null; available: number | null; iso_currency_code: string | null };
}

interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  name: string;
  merchant_name: string | null;
  amount: number; // Plaid convention: positive = money out of the account
  iso_currency_code: string | null;
  category: string[] | null;
  pending: boolean;
  date: string; // YYYY-MM-DD
  // FIN-002 "transaction ID mutation" — Plaid's own real, documented behavior: a pending transaction
  // sometimes gets an entirely NEW transaction_id once it posts, with this field on the POSTED transaction
  // pointing back at the old pending one's id (null for a transaction that was never previously pending
  // under a different id — the overwhelmingly common case). See upsertTransaction's own doc comment.
  pending_transaction_id?: string | null;
}

// FIN-005 "Track credit-card minimum/due date, loan/mortgage details and other supported liability
// fields" — shapes match Plaid's real `/liabilities/get` response schema (see PlaidAdapter.syncLiabilities'
// own doc comment); only the subset of fields this app actually stores is declared here, not every field
// Plaid returns.
interface PlaidApr {
  apr_percentage: number;
  apr_type: string; // "purchase_apr" | "cash_apr" | "balance_transfer_apr" | "special"
  balance_subject_to_apr: number | null;
  interest_charge_amount: number | null;
}

interface PlaidCreditCardLiability {
  account_id: string;
  aprs: PlaidApr[];
  is_overdue: boolean | null;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null; // YYYY-MM-DD
}

interface PlaidMortgageLiability {
  account_id: string;
  interest_rate: { percentage: number | null; type: string | null } | null;
  next_monthly_payment: number | null;
  next_payment_due_date: string | null;
}

interface PlaidStudentLoan {
  account_id: string;
  interest_rate_percentage: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
}

interface PlaidLiabilitiesResponse {
  liabilities: {
    credit: PlaidCreditCardLiability[] | null;
    mortgage: PlaidMortgageLiability[] | null;
    student: PlaidStudentLoan[] | null;
  };
}

/**
 * Phase 2 §52.2 "financial aggregator" (spec's feasibility class D — "Plaid-style partner abstracting
 * many institutions"). Unlike every other connector in this file, a user never gets redirected to Plaid's
 * own consent page via `authorizationUrl`/`handleCallback` — Plaid Link is a client-side widget the web/
 * mobile app embeds directly, which hands the client a `public_token` to POST here. That's why this
 * implements the plain `ConnectorAdapter` (isConfigured/initialSync/incrementalSync) rather than
 * `OAuthConnectorAdapter`: `createLinkToken`/`exchangePublicToken` are this adapter's own equivalent of
 * authorizationUrl/handleCallback, just shaped for Link instead of a redirect.
 *
 * Plaid is a real paid partner account (PLAID_CLIENT_ID/PLAID_SECRET), not a free OAuth app — unconfigured
 * in dev, same "not configured" degradation as every other connector, fully wired to activate the moment
 * real credentials are supplied.
 */
@Injectable()
export class PlaidAdapter implements ConnectorAdapter {
  private readonly logger = new Logger(PlaidAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("plaid");
  }

  private apiBase(): string {
    return loadEnv().PLAID_ENV === "production" ? "https://production.plaid.com" : "https://sandbox.plaid.com";
  }

  private async plaidPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const env = loadEnv();
    const response = await fetch(`${this.apiBase()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.PLAID_CLIENT_ID, secret: env.PLAID_SECRET, ...body }),
    });
    if (!response.ok) {
      throw plaidRequestError(path, response.status, await response.text());
    }
    return response.json() as Promise<T>;
  }

  /** Called by FinanceController right before rendering the Plaid Link widget client-side — a link_token
   * is single-use and short-lived, minted fresh per attempt rather than cached. */
  async createLinkToken(userId: string): Promise<{ linkToken: string; expiration: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("plaid");
    const response = await this.plaidPost<{ link_token: string; expiration: string }>("/link/token/create", {
      user: { client_user_id: userId },
      client_name: "Veynlo",
      // FIN-005 — "liabilities" must be requested as its own product at Link time (same as "transactions")
      // for Plaid to actually grant/consent it; without this, `/liabilities/get` would 400 for every item
      // connected through this Link flow regardless of what the linked institution itself supports.
      products: ["transactions", "liabilities"],
      country_codes: ["US"],
      language: "en",
    });
    return { linkToken: response.link_token, expiration: response.expiration };
  }

  /** Plaid Link's success callback hands the client a short-lived `public_token`; this is the one-time
   * exchange for a durable `access_token`, Link's equivalent of every other adapter's `handleCallback`. */
  async exchangePublicToken(params: {
    publicToken: string;
    ownerUserId: string;
    householdId: string | null;
    // ONB-002 — Plaid Link has no OAuth redirect round trip (see this class's own doc comment), so unlike
    // Gmail/Outlook there's no signed `state` needed to carry this: the onboarding UI just includes it
    // directly in this same request body it already makes right after Link's `onSuccess`.
    requestedHistoryDepthDays?: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("plaid");
    await this.entitlements.assertConnectorQuota(params.ownerUserId, "financial");

    const exchanged = await this.plaidPost<{ access_token: string; item_id: string }>("/item/public_token/exchange", {
      public_token: params.publicToken,
    });

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId, params.requestedHistoryDepthDays);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "plaid",
      feasibilityClass: "aggregator",
      scopes: ["transactions", "liabilities"], // PRIV-001 "granted scopes" display — mirrors createLinkToken's products list above
      enabledCategories: ["purchases", "bills"],
      health: "initializing",
      historyDepthDays,
    });
    const credentialRef = await this.vault.store(connectionId, { access_token: exchanged.access_token, item_id: exchanged.item_id }, null);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.syncAccounts(connectionId);
    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  private async credentials(connectionId: string): Promise<{ connection: typeof schema.connections.$inferSelect; creds: PlaidCredentials }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const creds = await this.vault.read(connection.credentialRef);
    if (!creds) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    return { connection, creds: creds as unknown as PlaidCredentials };
  }

  /** Refreshes `financial_accounts` from Plaid's current account list — balances drift constantly, so
   * this re-upserts by `plaidAccountId` rather than only inserting once at connect time. */
  private async syncAccounts(connectionId: string): Promise<void> {
    const { connection, creds } = await this.credentials(connectionId);
    const response = await this.plaidPost<{ accounts: PlaidAccount[] }>("/accounts/get", { access_token: creds.access_token });

    for (const account of response.accounts) {
      const [existing] = await this.db
        .select({ id: schema.financialAccounts.id })
        .from(schema.financialAccounts)
        .where(eq(schema.financialAccounts.plaidAccountId, account.account_id))
        .limit(1);
      const values = {
        name: account.name,
        officialName: account.official_name,
        type: account.type,
        subtype: account.subtype,
        mask: account.mask,
        currentBalanceMinorUnits: account.balances.current !== null ? Math.round(account.balances.current * 100) : null,
        availableBalanceMinorUnits: account.balances.available !== null ? Math.round(account.balances.available * 100) : null,
        currency: account.balances.iso_currency_code ?? "USD",
        updatedAt: new Date(),
      };
      if (existing) {
        await this.db.update(schema.financialAccounts).set(values).where(eq(schema.financialAccounts.id, existing.id));
      } else {
        await this.db.insert(schema.financialAccounts).values({
          id: generateId("financialAccount"),
          connectionId,
          ownerUserId: connection.ownerUserId,
          plaidAccountId: account.account_id,
          ...values,
        });
      }
    }
  }

  /**
   * FIN-005 "Track credit-card minimum/due date, loan/mortgage details and other supported liability
   * fields" — a real gap plugged via spec-conformance audit: no table or sync path existed for this at
   * all. Plaid's `/liabilities/get` is a separate endpoint from `/accounts/get`/`/transactions/sync`,
   * returning liability detail only for the subset of an item's accounts that are actually a credit card,
   * mortgage, or student loan (a checking/savings-only item simply gets back `{ credit: null, mortgage:
   * null, student: null }` — not an error, just nothing to store). Re-upserts by `financialAccounts.id`
   * (via the same plaidAccountId lookup upsertTransaction/syncAccounts already use) every sync, the same
   * "balances/terms drift, re-fetch every time" stance as syncAccounts itself — a minimum payment or due
   * date changes at least monthly.
   *
   * This dev environment has no real Plaid account to exercise the live call against (see
   * docs/PHASE2_PENDING_CREDENTIALS.md's Plaid entry) — the parsing/mapping below is verified against a
   * realistic mocked response matching Plaid's actual documented schema (plaid.adapter.test.ts), not a
   * live sandbox call.
   */
  private async syncLiabilities(connectionId: string): Promise<void> {
    const { connection, creds } = await this.credentials(connectionId);
    const response = await this.plaidPost<PlaidLiabilitiesResponse>("/liabilities/get", { access_token: creds.access_token });

    const upsert = async (
      plaidAccountId: string,
      values: {
        minimumPaymentMinorUnits: number | null;
        dueDate: string | null;
        aprBasisPoints: number | null;
        lastStatementBalanceMinorUnits: number | null;
      },
    ) => {
      const [account] = await this.db
        .select({ id: schema.financialAccounts.id })
        .from(schema.financialAccounts)
        .where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId))
        .limit(1);
      if (!account) return; // account list hasn't caught up yet — same "skip, next sync retries" stance as upsertTransaction
      const [existing] = await this.db.select({ id: schema.liabilities.id }).from(schema.liabilities).where(eq(schema.liabilities.accountId, account.id)).limit(1);
      if (existing) {
        await this.db
          .update(schema.liabilities)
          .set({ ...values, lastSyncedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.liabilities.id, existing.id));
      } else {
        await this.db.insert(schema.liabilities).values({
          id: generateId("liability"),
          accountId: account.id,
          ownerUserId: connection.ownerUserId,
          ...values,
        });
      }
    };

    for (const credit of response.liabilities.credit ?? []) {
      // Plaid returns one APR entry per balance type (purchase/cash advance/balance transfer/promotional)
      // on the same card — "purchase_apr" is the one that answers "what rate applies to typical spending",
      // the most useful single number to surface; falls back to whatever APR entry exists if that specific
      // type isn't present rather than showing nothing.
      const purchaseApr = credit.aprs.find((a) => a.apr_type === "purchase_apr") ?? credit.aprs[0] ?? null;
      await upsert(credit.account_id, {
        minimumPaymentMinorUnits: credit.minimum_payment_amount != null ? Math.round(credit.minimum_payment_amount * 100) : null,
        dueDate: credit.next_payment_due_date,
        aprBasisPoints: purchaseApr ? Math.round(purchaseApr.apr_percentage * 100) : null,
        lastStatementBalanceMinorUnits: credit.last_statement_balance != null ? Math.round(credit.last_statement_balance * 100) : null,
      });
    }
    for (const mortgage of response.liabilities.mortgage ?? []) {
      await upsert(mortgage.account_id, {
        minimumPaymentMinorUnits: mortgage.next_monthly_payment != null ? Math.round(mortgage.next_monthly_payment * 100) : null,
        dueDate: mortgage.next_payment_due_date,
        aprBasisPoints: mortgage.interest_rate?.percentage != null ? Math.round(mortgage.interest_rate.percentage * 100) : null,
        lastStatementBalanceMinorUnits: null, // Plaid's MortgageLiability has no statement-balance equivalent
      });
    }
    for (const student of response.liabilities.student ?? []) {
      await upsert(student.account_id, {
        minimumPaymentMinorUnits: student.minimum_payment_amount != null ? Math.round(student.minimum_payment_amount * 100) : null,
        dueDate: student.next_payment_due_date,
        aprBasisPoints: student.interest_rate_percentage != null ? Math.round(student.interest_rate_percentage * 100) : null,
        lastStatementBalanceMinorUnits: null, // Plaid's StudentLoan has no statement-balance equivalent either
      });
    }
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.syncTransactions(connectionId, null);
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection) throw new Error(`Connection ${connectionId} not found`);
    return this.syncTransactions(connectionId, connection.cursor);
  }

  /**
   * Plaid's `/transactions/sync` is the modern cursor-based endpoint (superseding the old date-range
   * `/transactions/get`) — the direct equivalent of Gmail's historyId, Calendar's syncToken, Drive's
   * changes-page-token: pass back whatever `next_cursor` the last call returned, get only what changed.
   */
  private async syncTransactions(connectionId: string, cursor: string | null): Promise<{ itemCount: number }> {
    const { connection, creds } = await this.credentials(connectionId);
    await this.syncAccounts(connectionId);
    try {
      await this.syncLiabilities(connectionId);
    } catch (err) {
      // FIN-005 — not every linked institution/account actually has liability data (a plain checking-only
      // item, or an institution that doesn't support Plaid's liabilities product at all, 400s here) — that
      // is a normal, common outcome, not a sync failure. Mirrors this same class's revoke()'s "best effort,
      // log and continue" stance rather than letting a liabilities-ineligible item break transaction sync.
      this.logger.warn(`Failed to sync liabilities for connection ${connectionId}: ${String(err)}`);
    }

    let itemCount = 0;
    let nextCursor = cursor;
    let hasMore = true;
    while (hasMore) {
      const page = await this.plaidPost<{
        added: PlaidTransaction[];
        modified: PlaidTransaction[];
        removed: { transaction_id: string }[];
        next_cursor: string;
        has_more: boolean;
      }>("/transactions/sync", { access_token: creds.access_token, cursor: nextCursor ?? undefined });

      for (const txn of [...page.added, ...page.modified]) {
        if (await this.upsertTransaction(connection, txn)) itemCount += 1;
      }
      for (const removed of page.removed) {
        await this.removeTransaction(removed.transaction_id);
      }
      nextCursor = page.next_cursor;
      hasMore = page.has_more;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: nextCursor,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /**
   * FIN-002 "Avoid showing pending+posted as duplicates; preserve provider transaction ID history and
   * transaction revisions" — see `transactionRevisions`' own schema doc comment for the two edge cases this
   * handles (§19.1 "transaction ID mutation, pending amount change"). A revision snapshot is written
   * immediately BEFORE either mutation overwrites/replaces the row, and only when something material
   * actually changed (see `hasMaterialTransactionChange`) — never for a no-op re-sync of identical values
   * (Plaid resends unchanged rows on every sync tick).
   */
  private async upsertTransaction(connection: typeof schema.connections.$inferSelect, txn: PlaidTransaction): Promise<boolean> {
    const [account] = await this.db
      .select({ id: schema.financialAccounts.id })
      .from(schema.financialAccounts)
      .where(eq(schema.financialAccounts.plaidAccountId, txn.account_id))
      .limit(1);
    if (!account) return false; // account list hasn't caught up yet — the next sync tick will retry this transaction

    const [existing] = await this.db
      .select()
      .from(schema.financialTransactions)
      .where(eq(schema.financialTransactions.plaidTransactionId, txn.transaction_id))
      .limit(1);

    const amountMinorUnits = Math.round(txn.amount * 100);
    const values = {
      name: txn.name,
      merchantName: txn.merchant_name,
      amountMinorUnits,
      currency: txn.iso_currency_code ?? "USD",
      category: txn.category ?? [],
      pending: txn.pending,
      postedDate: txn.date,
      updatedAt: new Date(),
    };

    let transactionId: string;
    let isNew = false;

    if (existing) {
      // Same provider transaction_id already on file — the "pending amount change" edge case (a bank
      // finalizes a pending transaction with a different amount/date, still under the same id), or a
      // genuine no-op re-sync.
      if (this.hasMaterialTransactionChange(existing, amountMinorUnits, txn.pending, txn.date)) {
        await this.snapshotTransactionRevision(existing, "pending_amount_changed");
      }
      await this.db.update(schema.financialTransactions).set(values).where(eq(schema.financialTransactions.id, existing.id));
      transactionId = existing.id;
    } else if (txn.pending_transaction_id) {
      // "Transaction ID mutation" — this posted transaction replaces an earlier pending row filed under a
      // DIFFERENT id (Plaid's own `pending_transaction_id` link). Migrate that row in place (new
      // plaidTransactionId + posted values) rather than inserting an unrelated new row, so the row's
      // internal id — and matchedPurchaseId/matchedBillId/matchedReturnCaseId links pinned to it — survive
      // the mutation instead of being silently orphaned by a hard delete-and-recreate.
      const [priorPending] = await this.db
        .select()
        .from(schema.financialTransactions)
        .where(eq(schema.financialTransactions.plaidTransactionId, txn.pending_transaction_id))
        .limit(1);
      if (priorPending) {
        await this.snapshotTransactionRevision(priorPending, "id_mutated");
        await this.db
          .update(schema.financialTransactions)
          .set({ ...values, plaidTransactionId: txn.transaction_id })
          .where(eq(schema.financialTransactions.id, priorPending.id));
        transactionId = priorPending.id;
      } else {
        // The pending row this is meant to replace isn't on file (e.g. it predates this account being
        // connected) — fall back to a plain insert, same as if there were no mutation at all.
        transactionId = generateId("financialTransaction");
        isNew = true;
        await this.db.insert(schema.financialTransactions).values({
          id: transactionId,
          accountId: account.id,
          ownerUserId: connection.ownerUserId,
          plaidTransactionId: txn.transaction_id,
          ...values,
        });
      }
    } else {
      transactionId = generateId("financialTransaction");
      isNew = true;
      await this.db.insert(schema.financialTransactions).values({
        id: transactionId,
        accountId: account.id,
        ownerUserId: connection.ownerUserId,
        plaidTransactionId: txn.transaction_id,
        ...values,
      });
    }

    if (!txn.pending) await this.matchTransaction(connection.ownerUserId, transactionId, amountMinorUnits, txn.date);
    return isNew;
  }

  /** Only a genuine change to a mutable field counts as material — a re-sync of byte-identical values must
   * never write a revision row (see transactionRevisions' own doc comment on why: "only when something
   * material actually changed"). */
  private hasMaterialTransactionChange(
    existing: typeof schema.financialTransactions.$inferSelect,
    amountMinorUnits: number,
    pending: boolean,
    postedDate: string,
  ): boolean {
    return existing.amountMinorUnits !== amountMinorUnits || existing.pending !== pending || existing.postedDate !== postedDate;
  }

  private async snapshotTransactionRevision(
    existing: typeof schema.financialTransactions.$inferSelect,
    reason: "pending_amount_changed" | "id_mutated" | "removed",
  ): Promise<void> {
    await this.db.insert(schema.transactionRevisions).values({
      id: generateId("transactionRevision"),
      financialTransactionId: existing.id,
      ownerUserId: existing.ownerUserId,
      accountId: existing.accountId,
      plaidTransactionId: existing.plaidTransactionId,
      amountMinorUnits: existing.amountMinorUnits,
      pending: existing.pending,
      postedDate: existing.postedDate,
      reason,
    });
  }

  /** A transaction Plaid reports as genuinely removed (a reversed/canceled charge) — distinct from the "id
   * mutation" case above, which never reaches here for the OLD id: that row's plaidTransactionId is
   * rewritten to the new id inside upsertTransaction before this ever runs, so this lookup safely finds
   * nothing and no-ops for that case. Snapshots a final revision before deleting so a genuine removal isn't
   * lost from history either. */
  private async removeTransaction(plaidTransactionId: string): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(schema.financialTransactions)
      .where(eq(schema.financialTransactions.plaidTransactionId, plaidTransactionId))
      .limit(1);
    if (!existing) return; // already migrated away by an id-mutation update, or never synced — nothing to remove
    await this.snapshotTransactionRevision(existing, "removed");
    await this.db.delete(schema.financialTransactions).where(eq(schema.financialTransactions.id, existing.id));
  }

  /**
   * §52.2's actual value in a financial aggregator isn't a second independent ledger — it's confirming
   * evidence already filed from email/document receipts. A pending transaction is skipped (the amount can
   * still change before it posts); matching is a same-amount, ±3-day window against not-yet-matched
   * purchases/bills. `bills.paymentObservedTransactionId` is a field the schema already reserved for
   * exactly this before the financial aggregator existed — set alongside the new
   * `financial_transactions.matchedBillId` rather than only recording the link on one side.
   *
   * §40.2 precision-first dedup — same "more than one candidate -> treat as no match" stance as every
   * IngestionService dedup helper (findExistingBill, findExistingPurchaseByAmountAndDate, etc). This used
   * to be "first unclaimed candidate wins," which is exactly the kind of silent guess that stance exists to
   * prevent: two genuinely different purchases bought on the same day for the same amount (a real,
   * unremarkable scenario — two $49.99 orders) would get arbitrarily cross-matched to whichever bank
   * transaction happened to be processed first, potentially attaching the WRONG transaction's evidence to
   * each purchase. Now collects every still-unclaimed candidate first and only commits the match when
   * exactly one remains ambiguous-free; each block still runs one "already claimed?" SELECT per candidate
   * rather than a single batched query — real, but an accepted MVP-scale tradeoff (a handful of same-
   * amount/date-window candidates per transaction, dozens of transactions per sync); worth batching if a
   * real account's sync volume ever makes it a hot path.
   */
  private async matchTransaction(ownerUserId: string, transactionId: string, amountMinorUnits: number, postedDate: string): Promise<void> {
    const posted = new Date(`${postedDate}T00:00:00Z`);
    const windowStart = new Date(posted.getTime() - MATCH_WINDOW_MS);
    const windowEnd = new Date(posted.getTime() + MATCH_WINDOW_MS);

    const candidatePurchases = await this.db
      .select({ id: schema.purchases.id })
      .from(schema.purchases)
      .where(
        and(
          eq(schema.purchases.ownerUserId, ownerUserId),
          eq(schema.purchases.totalMinorUnits, amountMinorUnits),
          gte(schema.purchases.purchaseDateSort, windowStart),
          lte(schema.purchases.purchaseDateSort, windowEnd),
        ),
      );
    const unclaimedPurchases: string[] = [];
    for (const candidate of candidatePurchases) {
      const [claimed] = await this.db
        .select({ id: schema.financialTransactions.id })
        .from(schema.financialTransactions)
        .where(eq(schema.financialTransactions.matchedPurchaseId, candidate.id))
        .limit(1);
      if (!claimed) unclaimedPurchases.push(candidate.id);
    }
    if (unclaimedPurchases.length === 1) {
      await this.db.update(schema.financialTransactions).set({ matchedPurchaseId: unclaimedPurchases[0] }).where(eq(schema.financialTransactions.id, transactionId));
      return;
    }

    const candidateBills = await this.db
      .select({ id: schema.bills.id })
      .from(schema.bills)
      .where(
        and(
          eq(schema.bills.ownerUserId, ownerUserId),
          eq(schema.bills.amountDueMinorUnits, amountMinorUnits),
          gte(schema.bills.dueDateSort, windowStart),
          lte(schema.bills.dueDateSort, windowEnd),
        ),
      );
    const unclaimedBills: string[] = [];
    for (const candidate of candidateBills) {
      const [claimed] = await this.db
        .select({ id: schema.financialTransactions.id })
        .from(schema.financialTransactions)
        .where(eq(schema.financialTransactions.matchedBillId, candidate.id))
        .limit(1);
      if (!claimed) unclaimedBills.push(candidate.id);
    }
    if (unclaimedBills.length === 1) {
      const [billId] = unclaimedBills;
      await this.db.update(schema.financialTransactions).set({ matchedBillId: billId }).where(eq(schema.financialTransactions.id, transactionId));
      await this.db.update(schema.bills).set({ paymentObservedTransactionId: transactionId, updatedAt: new Date() }).where(eq(schema.bills.id, billId!));
      return;
    }

    // RET-003 "detect whether promised refund actually arrived" — a refund is a CREDIT (negative
    // amountMinorUnits, Plaid's "positive = money out" convention), the mirror image of the purchase/bill
    // matches above. No fixed date window here (unlike purchases/bills): a refund can legitimately post
    // anywhere from days to weeks after a return ships, and `return_cases` has no single reliable "expect
    // it around this date" column to window against the way purchases/bills do — narrowed instead by
    // exact amount + owner + not already resolved + not already claimed.
    if (amountMinorUnits < 0) {
      const refundAmount = -amountMinorUnits;
      const candidateReturns = await this.db
        .select({ id: schema.returnCases.id })
        .from(schema.returnCases)
        .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
        .where(
          and(
            eq(schema.purchases.ownerUserId, ownerUserId),
            eq(schema.returnCases.valueAtStakeMinorUnits, refundAmount),
            ne(schema.returnCases.state, "resolved"),
          ),
        );
      const unclaimedReturns: string[] = [];
      for (const candidate of candidateReturns) {
        const [claimed] = await this.db
          .select({ id: schema.financialTransactions.id })
          .from(schema.financialTransactions)
          .where(eq(schema.financialTransactions.matchedReturnCaseId, candidate.id))
          .limit(1);
        if (!claimed) unclaimedReturns.push(candidate.id);
      }
      if (unclaimedReturns.length === 1) {
        const [returnCaseId] = unclaimedReturns;
        await this.db.update(schema.financialTransactions).set({ matchedReturnCaseId: returnCaseId }).where(eq(schema.financialTransactions.id, transactionId));
        // CommerceService.resolveReturn's own doc comment noted the automatic version of this "mark the
        // return actually done" transition "needs the Phase 2 financial aggregator connector, which
        // doesn't exist yet" — it exists now (this adapter). A matched refund transaction IS the automatic
        // confirmation RET-003 describes ("detect whether promised refund actually arrived"); without also
        // setting `state: "resolved"` here, the return case stayed "eligible" forever even after its refund
        // was observed — savingsSummary's resolved-returns aggregate would never count it, and (more
        // seriously) AttentionService.scanAndFileDeadlines only queries `state = "eligible"` for return-
        // deadline reminders, so a user could keep getting "your return deadline is approaching" nags for an
        // item they were already refunded for.
        await this.db
          .update(schema.returnCases)
          .set({ refundObservedTransactionId: transactionId, state: "resolved", updatedAt: new Date() })
          .where(eq(schema.returnCases.id, returnCaseId!));
      }
    }
  }

  /**
   * §43/CONN-001 webhook signature verification (webhook-verification.ts's `verifyPlaidWebhook`) — Plaid
   * rotates its ES256 webhook-signing keys occasionally and documents `/webhook_verification_key/get` as
   * safe (and expected) to call once per unseen `kid`, then cache; the small in-memory cache itself lives
   * in `webhooks.controller.ts`, not here, so this method is a plain, uncached passthrough. Returns `null`
   * (rather than throwing) both when Plaid isn't configured on this deployment and when the key has already
   * expired — an expired key must never be treated as currently valid.
   */
  async getWebhookVerificationKey(keyId: string): Promise<Record<string, unknown> | null> {
    if (!this.isConfigured()) return null;
    try {
      const response = await this.plaidPost<{ key: { expired_at: string | null } & Record<string, unknown> }>("/webhook_verification_key/get", {
        key_id: keyId,
      });
      if (response.key.expired_at) return null;
      return response.key;
    } catch (err) {
      this.logger.warn(`Failed to fetch Plaid webhook verification key ${keyId}: ${String(err)}`);
      return null;
    }
  }

  /** Called by ConnectorsService.disconnect on every Plaid disconnect (not just the delete-derived-data
   * variant) — Plaid's `/item/remove` invalidates the access_token server-side so it can't keep being
   * billed/used after the user disconnects, not just deleted from our own vault. */
  async revoke(connectionId: string): Promise<void> {
    try {
      const { creds } = await this.credentials(connectionId);
      await this.plaidPost("/item/remove", { access_token: creds.access_token });
    } catch (err) {
      this.logger.warn(`Failed to revoke Plaid item for connection ${connectionId}: ${String(err)}`);
    }
  }
}
