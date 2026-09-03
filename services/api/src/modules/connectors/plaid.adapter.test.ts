import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PlaidAdapter } from "./plaid.adapter";
import { CredentialVault } from "../../common/credential-vault";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * Phase 2 §52.2 "financial aggregator" — the interesting, easy-to-get-wrong behavior here is the matching
 * logic (`PlaidAdapter.matchTransaction`, exercised indirectly through the public sync methods): a synced
 * bank transaction should link up with an existing purchase/bill by amount + date proximity, and — since
 * `bills.paymentObservedTransactionId` was a field the schema reserved for exactly this before the
 * aggregator existed — that field should get set too, not just the new `financial_transactions.matchedBillId`
 * column. Plaid's actual REST API is mocked at the `fetch` boundary (real network calls need a real paid
 * Plaid sandbox account this environment doesn't have); everything on this side of that boundary — the DB
 * writes, the matching query, the cursor bookkeeping — is exercised for real against a real DB.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

// `isConnectorConfigured("plaid")` gates every PlaidAdapter method on real PLAID_CLIENT_ID/PLAID_SECRET —
// set before config/env.ts's own module-scoped `loadEnv()` cache is populated by anything else in this
// test file, so the adapter behaves as "configured" the same way it would with real (sandbox) credentials.
process.env.PLAID_CLIENT_ID = "test-plaid-client-id";
process.env.PLAID_SECRET = "test-plaid-secret";

const stubEntitlements = {
  assertConnectorQuota: async () => {},
  resolveHistoricalBackfillDays: async () => 90,
} as unknown as EntitlementsService;
const stubQueue = { enqueueConnectorSync: async () => {} } as unknown as QueueProducer;

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("PlaidAdapter sync + matching", () => {
  let db: Database;
  let plaid: PlaidAdapter;
  let ownerUserId: string;
  let purchaseId: string;
  let billId: string;
  let returnCaseId: string;
  let dbAvailable = true;
  const today = new Date().toISOString().slice(0, 10);
  const originalFetch = global.fetch;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const vault = new CredentialVault(db);
    plaid = new PlaidAdapter(db, vault, stubEntitlements, stubQueue);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `plaid-test-${ownerUserId}@example.com`, displayName: "Plaid Test" });

      purchaseId = generateId("purchase");
      await db.insert(schema.purchases).values({
        id: purchaseId,
        ownerUserId,
        purchaseDate: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
        purchaseDateSort: new Date(`${today}T00:00:00Z`),
        totalMinorUnits: 4_999,
        totalCurrency: "USD",
        state: "confirmed",
        confidenceBand: "high",
      });

      billId = generateId("bill");
      await db.insert(schema.bills).values({
        id: billId,
        ownerUserId,
        billerLabel: "Test Electric Co",
        amountDueMinorUnits: 12_000,
        amountDueCurrency: "USD",
        dueDate: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
        dueDateSort: new Date(`${today}T00:00:00Z`),
      });

      returnCaseId = generateId("returnCase");
      await db.insert(schema.returnCases).values({
        id: returnCaseId,
        purchaseId,
        state: "eligible",
        deadline: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
        deadlineSort: new Date(`${today}T00:00:00Z`),
        valueAtStakeMinorUnits: 3_000,
        valueAtStakeCurrency: "USD",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PlaidAdapter tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("exchanges a public token, syncs accounts + transactions, and matches both a purchase and a bill", async () => {
    if (!dbAvailable) return;

    const plaidAccountId = generateId("financialAccount");
    const purchaseTxnId = generateId("financialTransaction");
    const billTxnId = generateId("financialTransaction");
    const refundTxnId = generateId("financialTransaction");

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/item/public_token/exchange")) {
        return jsonResponse({ access_token: "access-sandbox-test", item_id: "item-sandbox-test" });
      }
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Checking",
              official_name: "Test Bank Checking Account",
              type: "depository",
              subtype: "checking",
              mask: "1234",
              balances: { current: 500.25, available: 480.0, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) {
        // FIN-005 — this account is a plain checking account, so a real Plaid response would report no
        // liability data for it at all; verifies syncTransactions tolerates an empty liabilities response
        // (this test's own assertions are about the purchase/bill/refund matching, not liabilities).
        return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      }
      if (url.includes("/transactions/sync")) {
        return jsonResponse({
          added: [
            {
              transaction_id: purchaseTxnId,
              account_id: plaidAccountId,
              name: "Merchant Purchase",
              merchant_name: "Test Merchant",
              amount: 49.99,
              iso_currency_code: "USD",
              category: ["Shops"],
              pending: false,
              date: today,
            },
            {
              transaction_id: billTxnId,
              account_id: plaidAccountId,
              name: "Electric Co Autopay",
              merchant_name: "Test Electric Co",
              amount: 120.0,
              iso_currency_code: "USD",
              category: ["Utilities"],
              pending: false,
              date: today,
            },
            {
              transaction_id: refundTxnId,
              account_id: plaidAccountId,
              name: "Merchant Refund",
              merchant_name: "Test Merchant",
              amount: -30.0,
              iso_currency_code: "USD",
              category: ["Shops"],
              pending: false,
              date: today,
            },
          ],
          modified: [],
          removed: [],
          next_cursor: "cursor-1",
          has_more: false,
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { connectionId } = await plaid.exchangePublicToken({ publicToken: "public-sandbox-test", ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);

    const [account] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId));
    expect(account).toBeDefined();
    expect(account?.currentBalanceMinorUnits).toBe(50_025);

    const [purchaseTxn] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, purchaseTxnId));
    expect(purchaseTxn?.matchedPurchaseId).toBe(purchaseId);
    expect(purchaseTxn?.matchedBillId).toBeNull();

    const [billTxn] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, billTxnId));
    expect(billTxn?.matchedBillId).toBe(billId);
    expect(billTxn?.matchedPurchaseId).toBeNull();

    const [updatedBill] = await db.select().from(schema.bills).where(eq(schema.bills.id, billId));
    expect(updatedBill?.paymentObservedTransactionId).toBe(billTxn?.id);

    // RET-003 "detect whether promised refund actually arrived" — the refund transaction (negative
    // amount) should match the open return case by amount, not the purchase/bill matches above.
    const [refundTxn] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, refundTxnId));
    expect(refundTxn?.matchedReturnCaseId).toBe(returnCaseId);
    expect(refundTxn?.matchedPurchaseId).toBeNull();
    expect(refundTxn?.matchedBillId).toBeNull();

    const [updatedReturn] = await db.select().from(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    expect(updatedReturn?.refundObservedTransactionId).toBe(refundTxn?.id);
    // A matched refund transaction is the automatic confirmation RET-003 describes — the return case must
    // actually close out (state -> "resolved"), not just record the transaction link. Before this was
    // fixed, `state` stayed "eligible" forever, so AttentionService kept alerting on an already-refunded
    // return's deadline and CommerceService.savingsSummary's resolved-returns total never counted it.
    expect(updatedReturn?.state).toBe("resolved");

    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connection?.health).toBe("healthy");
    expect(connection?.cursor).toBe("cursor-1");

    // Cleanup — the users delete in afterAll cascades most of this, but financial_transactions.matchedBillId
    // has an ON DELETE SET NULL to bills, so bills must go first or the row lingers as an orphan reference
    // check; deleting explicitly here keeps this test's footprint self-contained rather than relying on cascade order.
    await db.delete(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    await db.delete(schema.financialAccounts).where(eq(schema.financialAccounts.id, account!.id));
    await db.delete(schema.bills).where(eq(schema.bills.id, billId));
    await db.delete(schema.returnCases).where(eq(schema.returnCases.id, returnCaseId));
    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseId));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });

  it("does not cross-match when two genuinely different purchases share the same amount and date (precision-first, no guessing)", async () => {
    if (!dbAvailable) return;

    // Two real, unrelated $19.99 purchases from different merchants on the same day — a plausible,
    // unremarkable scenario. Before the fix, matchTransaction picked the first unclaimed candidate
    // regardless of which transaction it actually corresponded to; now it must recognize the ambiguity
    // and match neither, rather than silently attaching a bank transaction's evidence to the wrong purchase.
    const ambiguousAmount = 1_999;
    const purchaseA = generateId("purchase");
    const purchaseB = generateId("purchase");
    await db.insert(schema.purchases).values([
      {
        id: purchaseA,
        ownerUserId,
        purchaseDate: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
        purchaseDateSort: new Date(`${today}T00:00:00Z`),
        totalMinorUnits: ambiguousAmount,
        totalCurrency: "USD",
        state: "confirmed",
        confidenceBand: "high",
      },
      {
        id: purchaseB,
        ownerUserId,
        purchaseDate: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
        purchaseDateSort: new Date(`${today}T00:00:00Z`),
        totalMinorUnits: ambiguousAmount,
        totalCurrency: "USD",
        state: "confirmed",
        confidenceBand: "high",
      },
    ]);

    const plaidAccountId = generateId("financialAccount");
    const ambiguousTxnId = generateId("financialTransaction");
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/item/public_token/exchange")) return jsonResponse({ access_token: "access-sandbox-test-2", item_id: "item-sandbox-test-2" });
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Checking 2",
              official_name: "Test Bank Checking Account 2",
              type: "depository",
              subtype: "checking",
              mask: "5678",
              balances: { current: 100.0, available: 100.0, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) {
        return jsonResponse({
          added: [
            {
              transaction_id: ambiguousTxnId,
              account_id: plaidAccountId,
              name: "Some Purchase",
              merchant_name: "Ambiguous Merchant",
              amount: 19.99,
              iso_currency_code: "USD",
              category: ["Shops"],
              pending: false,
              date: today,
            },
          ],
          modified: [],
          removed: [],
          next_cursor: "cursor-2",
          has_more: false,
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { connectionId } = await plaid.exchangePublicToken({ publicToken: "public-sandbox-test-2", ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);

    const [txn] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, ambiguousTxnId));
    expect(txn?.matchedPurchaseId).toBeNull(); // ambiguous — must not guess between purchaseA and purchaseB

    const [account] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId));
    await db.delete(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    await db.delete(schema.financialAccounts).where(eq(schema.financialAccounts.id, account!.id));
    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseA));
    await db.delete(schema.purchases).where(eq(schema.purchases.id, purchaseB));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });

  // FIN-002 "avoid showing pending+posted as duplicates" — the case that actually exercises this isn't a
  // transaction that keeps the same plaidTransactionId as it posts (upsertTransaction's own existing-row
  // update already trivially handles that); it's the common real-world Plaid behavior where a pending
  // transaction posts under a BRAND NEW transaction_id, and Plaid's `/transactions/sync` reports the old
  // pending id in `removed` in the same page (or a later page) that `added`s the new posted one. This test
  // was previously missing — the two existing tests above only ever exercise a single already-posted sync
  // page — leaving the pending->posted transition path (the `removed` handling in `syncTransactions`, plus
  // `upsertTransaction`'s "skip matching while pending" branch) unverified by any real DB assertion.
  it("does not double-count a transaction that posts under a new provider id after first appearing pending (pending->posted, no duplicate)", async () => {
    if (!dbAvailable) return;

    const transitionBillId = generateId("bill");
    await db.insert(schema.bills).values({
      id: transitionBillId,
      ownerUserId,
      billerLabel: "Test Water Co",
      amountDueMinorUnits: 8_000,
      amountDueCurrency: "USD",
      dueDate: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
      dueDateSort: new Date(`${today}T00:00:00Z`),
    });

    const plaidAccountId = generateId("financialAccount");
    const pendingTxnId = generateId("financialTransaction");
    const postedTxnId = generateId("financialTransaction");
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.includes("/item/public_token/exchange")) return jsonResponse({ access_token: "access-sandbox-test-3", item_id: "item-sandbox-test-3" });
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Checking 3",
              official_name: "Test Bank Checking Account 3",
              type: "depository",
              subtype: "checking",
              mask: "9012",
              balances: { current: 200.0, available: 200.0, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) {
        const body = init?.body ? (JSON.parse(init.body) as { cursor?: string }) : {};
        if (!body.cursor) {
          // First sync page: the charge has only shown up as pending so far, under its own transaction_id.
          return jsonResponse({
            added: [
              {
                transaction_id: pendingTxnId,
                account_id: plaidAccountId,
                name: "Water Co Pending Autopay",
                merchant_name: "Test Water Co",
                amount: 80.0,
                iso_currency_code: "USD",
                category: ["Utilities"],
                pending: true,
                date: today,
              },
            ],
            modified: [],
            removed: [],
            next_cursor: "cursor-transition-pending",
            has_more: false,
          });
        }
        // Second sync page (incremental, cursor from the first page): Plaid reports the same real-world
        // charge posting under a DIFFERENT transaction_id, and removes the old pending one in the same page.
        return jsonResponse({
          added: [
            {
              transaction_id: postedTxnId,
              account_id: plaidAccountId,
              name: "Water Co Autopay",
              merchant_name: "Test Water Co",
              amount: 80.0,
              iso_currency_code: "USD",
              category: ["Utilities"],
              pending: false,
              date: today,
            },
          ],
          modified: [],
          removed: [{ transaction_id: pendingTxnId }],
          next_cursor: "cursor-transition-posted",
          has_more: false,
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { connectionId } = await plaid.exchangePublicToken({ publicToken: "public-sandbox-test-3", ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);

    const [account] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId));
    const pendingRowsBeforePost = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    expect(pendingRowsBeforePost).toHaveLength(1);
    expect(pendingRowsBeforePost[0]?.pending).toBe(true);
    expect(pendingRowsBeforePost[0]?.matchedBillId).toBeNull(); // pending amounts can still change — must not match yet

    await plaid.incrementalSync(connectionId);

    // The old pending row must be gone entirely, not left sitting alongside the posted one as a duplicate.
    const [staleRow] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, pendingTxnId));
    expect(staleRow).toBeUndefined();

    const allRowsAfterPost = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    expect(allRowsAfterPost).toHaveLength(1); // exactly one row for this real-world charge, never two

    const [postedRow] = allRowsAfterPost;
    expect(postedRow?.plaidTransactionId).toBe(postedTxnId);
    expect(postedRow?.pending).toBe(false);
    expect(postedRow?.matchedBillId).toBe(transitionBillId);

    const [updatedBill] = await db.select().from(schema.bills).where(eq(schema.bills.id, transitionBillId));
    expect(updatedBill?.paymentObservedTransactionId).toBe(postedRow?.id);

    await db.delete(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    await db.delete(schema.financialAccounts).where(eq(schema.financialAccounts.id, account!.id));
    await db.delete(schema.bills).where(eq(schema.bills.id, transitionBillId));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });

  // FIN-005 "Track credit-card minimum/due date, loan/mortgage details" — no real Plaid account exists in
  // this dev environment to exercise `/liabilities/get` against live (see
  // docs/PHASE2_PENDING_CREDENTIALS.md), so this proves the parsing/storage side for real against a
  // response shaped exactly like Plaid's own documented CreditCardLiability schema (account_id, aprs[],
  // minimum_payment_amount, next_payment_due_date, last_statement_balance).
  it("parses a realistic Plaid /liabilities/get credit-card response into the liabilities table", async () => {
    if (!dbAvailable) return;

    const plaidAccountId = generateId("financialAccount");
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/item/public_token/exchange")) return jsonResponse({ access_token: "access-sandbox-test-4", item_id: "item-sandbox-test-4" });
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Rewards Card",
              official_name: "Test Bank Rewards Visa",
              type: "credit",
              subtype: "credit card",
              mask: "4321",
              balances: { current: 842.17, available: 4157.83, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) {
        return jsonResponse({
          liabilities: {
            credit: [
              {
                account_id: plaidAccountId,
                aprs: [
                  { apr_percentage: 24.99, apr_type: "cash_apr", balance_subject_to_apr: 0, interest_charge_amount: 0 },
                  { apr_percentage: 21.49, apr_type: "purchase_apr", balance_subject_to_apr: 842.17, interest_charge_amount: 12.34 },
                ],
                is_overdue: false,
                last_statement_balance: 910.44,
                minimum_payment_amount: 35.0,
                next_payment_due_date: "2026-09-15",
              },
            ],
            mortgage: null,
            student: null,
          },
        });
      }
      if (url.includes("/transactions/sync")) {
        return jsonResponse({ added: [], modified: [], removed: [], next_cursor: "cursor-liab-1", has_more: false });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { connectionId } = await plaid.exchangePublicToken({ publicToken: "public-sandbox-test-4", ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);

    const [account] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId));
    expect(account).toBeDefined();

    const [liability] = await db.select().from(schema.liabilities).where(eq(schema.liabilities.accountId, account!.id));
    expect(liability).toBeDefined();
    expect(liability?.minimumPaymentMinorUnits).toBe(3_500);
    expect(liability?.dueDate).toBe("2026-09-15");
    // Must pick the "purchase_apr" entry (21.49%), not just the first APR in the array (24.99% cash APR).
    expect(liability?.aprBasisPoints).toBe(2_149);
    expect(liability?.lastStatementBalanceMinorUnits).toBe(91_044);

    // Re-syncing (incrementalSync re-runs syncLiabilities every time, same as syncAccounts) with an
    // updated minimum payment must UPDATE the existing row, not insert a second one for the same account.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Rewards Card",
              official_name: "Test Bank Rewards Visa",
              type: "credit",
              subtype: "credit card",
              mask: "4321",
              balances: { current: 900.0, available: 4100.0, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) {
        return jsonResponse({
          liabilities: {
            credit: [
              {
                account_id: plaidAccountId,
                aprs: [{ apr_percentage: 21.49, apr_type: "purchase_apr", balance_subject_to_apr: 900, interest_charge_amount: 15.0 }],
                is_overdue: false,
                last_statement_balance: 950.0,
                minimum_payment_amount: 40.0,
                next_payment_due_date: "2026-10-15",
              },
            ],
            mortgage: null,
            student: null,
          },
        });
      }
      if (url.includes("/transactions/sync")) {
        return jsonResponse({ added: [], modified: [], removed: [], next_cursor: "cursor-liab-2", has_more: false });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    await plaid.incrementalSync(connectionId);

    const liabilityRows = await db.select().from(schema.liabilities).where(eq(schema.liabilities.accountId, account!.id));
    expect(liabilityRows).toHaveLength(1); // updated in place, not duplicated
    expect(liabilityRows[0]?.minimumPaymentMinorUnits).toBe(4_000);
    expect(liabilityRows[0]?.dueDate).toBe("2026-10-15");

    await db.delete(schema.liabilities).where(eq(schema.liabilities.accountId, account!.id));
    await db.delete(schema.financialAccounts).where(eq(schema.financialAccounts.id, account!.id));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });

  // FIN-002 "pending amount change" — a bank posts a transaction pending with an estimated amount, then
  // finalizes it later with a DIFFERENT amount, still under the SAME provider transaction_id. Before this
  // fix, `upsertTransaction` overwrote the row with no trail at all; now a `transaction_revisions` row must
  // snapshot the pre-change (pending, estimated-amount) state first.
  it("snapshots a transaction_revisions row when a pending amount changes before posting under the same provider id", async () => {
    if (!dbAvailable) return;

    const plaidAccountId = generateId("financialAccount");
    const txnId = generateId("financialTransaction");
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.includes("/item/public_token/exchange")) return jsonResponse({ access_token: "access-sandbox-test-5", item_id: "item-sandbox-test-5" });
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Checking 5",
              official_name: "Test Bank Checking Account 5",
              type: "depository",
              subtype: "checking",
              mask: "1111",
              balances: { current: 300.0, available: 300.0, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) {
        const body = init?.body ? (JSON.parse(init.body) as { cursor?: string }) : {};
        if (!body.cursor) {
          return jsonResponse({
            added: [
              {
                transaction_id: txnId,
                account_id: plaidAccountId,
                name: "Restaurant Tab (pending estimate)",
                merchant_name: "Test Restaurant",
                amount: 50.0,
                iso_currency_code: "USD",
                category: ["Food"],
                pending: true,
                date: today,
              },
            ],
            modified: [],
            removed: [],
            next_cursor: "cursor-pendingamt-1",
            has_more: false,
          });
        }
        if (body.cursor === "cursor-pendingamt-1") {
          // A resync reporting the SAME transaction with byte-identical values (Plaid resends unchanged
          // rows on every sync tick) — must NOT write a revision.
          return jsonResponse({
            added: [],
            modified: [
              {
                transaction_id: txnId,
                account_id: plaidAccountId,
                name: "Restaurant Tab (pending estimate)",
                merchant_name: "Test Restaurant",
                amount: 50.0,
                iso_currency_code: "USD",
                category: ["Food"],
                pending: true,
                date: today,
              },
            ],
            removed: [],
            next_cursor: "cursor-pendingamt-2",
            has_more: false,
          });
        }
        // Same transaction_id, finalized with a different (tip-adjusted) amount and no longer pending.
        return jsonResponse({
          added: [],
          modified: [
            {
              transaction_id: txnId,
              account_id: plaidAccountId,
              name: "Restaurant Tab",
              merchant_name: "Test Restaurant",
              amount: 61.5,
              iso_currency_code: "USD",
              category: ["Food"],
              pending: false,
              date: today,
            },
          ],
          removed: [],
          next_cursor: "cursor-pendingamt-3",
          has_more: false,
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { connectionId } = await plaid.exchangePublicToken({ publicToken: "public-sandbox-test-5", ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);
    // Re-sync reporting the identical pending values again — must NOT write a revision for a no-op resync.
    await plaid.incrementalSync(connectionId);

    const [account] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId));
    const [pendingRow] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, txnId));
    const revisionsAfterNoOpResync = await db.select().from(schema.transactionRevisions).where(eq(schema.transactionRevisions.financialTransactionId, pendingRow!.id));
    expect(revisionsAfterNoOpResync).toHaveLength(0);

    await plaid.incrementalSync(connectionId); // consumes the "finalized" page

    const [finalizedRow] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, txnId));
    expect(finalizedRow?.id).toBe(pendingRow?.id); // same internal row, updated in place
    expect(finalizedRow?.amountMinorUnits).toBe(6_150);
    expect(finalizedRow?.pending).toBe(false);

    const revisions = await db
      .select()
      .from(schema.transactionRevisions)
      .where(eq(schema.transactionRevisions.financialTransactionId, pendingRow!.id));
    expect(revisions).toHaveLength(1); // exactly one snapshot — the material pending->posted amount change
    expect(revisions[0]?.reason).toBe("pending_amount_changed");
    expect(revisions[0]?.amountMinorUnits).toBe(5_000); // the OLD (pre-change) estimated amount
    expect(revisions[0]?.pending).toBe(true); // the OLD (pre-change) pending state
    expect(revisions[0]?.plaidTransactionId).toBe(txnId);

    await db.delete(schema.transactionRevisions).where(eq(schema.transactionRevisions.financialTransactionId, pendingRow!.id));
    await db.delete(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    await db.delete(schema.financialAccounts).where(eq(schema.financialAccounts.id, account!.id));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });

  // FIN-002 "transaction ID mutation" — Plaid's own documented `pending_transaction_id` link: a posted
  // transaction can arrive under a brand new transaction_id while pointing back at the pending row it
  // replaces. This must migrate the EXISTING row (preserving its internal id and matched* links) rather
  // than hard-deleting it and inserting an unrelated new one, and must snapshot a revision first.
  it("migrates the existing row in place (preserving matched links) when a posted transaction's pending_transaction_id links back to an earlier pending row", async () => {
    if (!dbAvailable) return;

    const mutationBillId = generateId("bill");
    await db.insert(schema.bills).values({
      id: mutationBillId,
      ownerUserId,
      billerLabel: "Test Gas Co",
      amountDueMinorUnits: 7_500,
      amountDueCurrency: "USD",
      dueDate: { precision: "date", instantUtc: null, date: today, timezone: null, sourceText: null },
      dueDateSort: new Date(`${today}T00:00:00Z`),
    });

    const plaidAccountId = generateId("financialAccount");
    const pendingTxnId = generateId("financialTransaction");
    const postedTxnId = generateId("financialTransaction");
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
      if (url.includes("/item/public_token/exchange")) return jsonResponse({ access_token: "access-sandbox-test-6", item_id: "item-sandbox-test-6" });
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: plaidAccountId,
              name: "Test Checking 6",
              official_name: "Test Bank Checking Account 6",
              type: "depository",
              subtype: "checking",
              mask: "2222",
              balances: { current: 400.0, available: 400.0, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) {
        const body = init?.body ? (JSON.parse(init.body) as { cursor?: string }) : {};
        if (!body.cursor) {
          return jsonResponse({
            added: [
              {
                transaction_id: pendingTxnId,
                account_id: plaidAccountId,
                name: "Gas Co Pending Autopay",
                merchant_name: "Test Gas Co",
                amount: 75.0,
                iso_currency_code: "USD",
                category: ["Utilities"],
                pending: true,
                date: today,
              },
            ],
            modified: [],
            removed: [],
            next_cursor: "cursor-idmutation-1",
            has_more: false,
          });
        }
        return jsonResponse({
          added: [
            {
              transaction_id: postedTxnId,
              account_id: plaidAccountId,
              name: "Gas Co Autopay",
              merchant_name: "Test Gas Co",
              amount: 75.0,
              iso_currency_code: "USD",
              category: ["Utilities"],
              pending: false,
              date: today,
              pending_transaction_id: pendingTxnId,
            },
          ],
          modified: [],
          removed: [{ transaction_id: pendingTxnId }],
          next_cursor: "cursor-idmutation-2",
          has_more: false,
        });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    const { connectionId } = await plaid.exchangePublicToken({ publicToken: "public-sandbox-test-6", ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);

    const [account] = await db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.plaidAccountId, plaidAccountId));
    const [pendingRow] = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, pendingTxnId));
    const pendingRowInternalId = pendingRow!.id;

    await plaid.incrementalSync(connectionId);

    // Exactly one row for this real-world charge — the old id must no longer resolve to anything.
    const staleLookup = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.plaidTransactionId, pendingTxnId));
    expect(staleLookup).toHaveLength(0);

    const allRows = await db.select().from(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    expect(allRows).toHaveLength(1);

    const [migratedRow] = allRows;
    // The whole point of the pending_transaction_id link: this is the SAME internal row, not a fresh insert.
    expect(migratedRow?.id).toBe(pendingRowInternalId);
    expect(migratedRow?.plaidTransactionId).toBe(postedTxnId);
    expect(migratedRow?.pending).toBe(false);
    expect(migratedRow?.matchedBillId).toBe(mutationBillId); // matching ran against the migrated row, post-mutation

    const revisions = await db.select().from(schema.transactionRevisions).where(eq(schema.transactionRevisions.financialTransactionId, pendingRowInternalId));
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.reason).toBe("id_mutated");
    expect(revisions[0]?.plaidTransactionId).toBe(pendingTxnId); // the OLD provider id, preserved in history
    expect(revisions[0]?.pending).toBe(true);

    await db.delete(schema.transactionRevisions).where(eq(schema.transactionRevisions.financialTransactionId, pendingRowInternalId));
    await db.delete(schema.financialTransactions).where(eq(schema.financialTransactions.accountId, account!.id));
    await db.delete(schema.financialAccounts).where(eq(schema.financialAccounts.id, account!.id));
    await db.delete(schema.bills).where(eq(schema.bills.id, mutationBillId));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });
});
