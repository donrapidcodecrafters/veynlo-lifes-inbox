import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNull, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { AttentionService } from "../attention/attention.service";

// FIN-003 "Model paycheck and recurring expenses as expected streams" — precision-first tolerances,
// documented so the discipline is visible rather than implicit in magic numbers. An amount is only
// considered part of the same income stream when it's within this fraction of the group's median
// (paychecks vary slightly run to run — a small raise, a different number of overtime hours — but a
// materially different amount is a different, unrelated deposit, not the same stream).
const INCOME_AMOUNT_TOLERANCE = 0.05;
// Never surface a "detected" stream on 1-2 occurrences — that's a coincidence, not a pattern. Mirrors the
// same "more than one candidate -> treat as no match"/precision-first stance used throughout this
// codebase's other recurring-detection code (e.g. IngestionService's recurring-stream dedup).
const INCOME_MIN_OCCURRENCES = 3;

// FIN-004 "Surface possible duplicate or unexpectedly different charge assistance" — reuses
// CommerceService.computeBillBaseline's exact threshold/sample-size discipline (see that method's own
// doc comment for why), applied to transactions instead of bills.
const TRANSACTION_BASELINE_SIGNIFICANT_THRESHOLD = 0.25;
const TRANSACTION_BASELINE_MAX_SAMPLE = 12;
const TRANSACTION_BASELINE_MIN_SAMPLE = 2;
// "Two transactions ... within a short window" — financial_transactions.postedDate is date-only
// (Plaid's own YYYY-MM-DD convention, see the schema's doc comment), so there's no time-of-day to check a
// true 24-48h window against. A 2-calendar-day gap is the closest date-only approximation of "24-48
// hours" (same-day or next-day) without either under- or over-matching by a whole extra day.
const DUPLICATE_CHARGE_WINDOW_DAYS = 2;
// How far back the periodic scan looks for NEW anomalies to flag — bounded so this doesn't re-walk a
// user's entire transaction history every hour (mirrors AttentionService.scanAndFileDeadlines's own
// bounded lookback/lookahead windows). fileIfNew's dedup means re-scanning the same transaction twice is
// harmless, but pointless — accounts.controller.ts's dueAtSort-style windows keep the query cheap instead
// of relying on dedup alone to keep this fast.
const ANOMALY_SCAN_LOOKBACK_DAYS = 14;

function normalizeDescription(name: string, merchantName: string | null): string {
  return (merchantName ?? name).trim().toLowerCase();
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

/**
 * FIN-003 cadence classification — a real gap plugged via spec-conformance audit (zero code existed for
 * this before). Deliberately conservative: only classifies a cadence when the gaps between occurrences
 * are consistent enough to look like a genuine schedule rather than coincidental timing, and returns null
 * (not flagged at all) for anything ambiguous — a missed paycheck stream is a much smaller cost than a
 * false "recurring income" claim about money that isn't actually recurring.
 *
 * Weekly/biweekly pay is anchored to a day-of-week, so its gaps are tightly consistent (max deviation from
 * the average of at most 2 days — allowing for the rare bank-holiday shift). Semimonthly pay (e.g. the 1st
 * and 15th) is anchored to a day-of-MONTH instead, so its gap alternates between two different values as
 * months vary in length (14 days one half of the month, 16-17 the other) — a materially looser but still
 * bounded deviation (up to 5 days) than biweekly's, which is the actual distinguishing signal used here
 * rather than guessing from the average alone (a biweekly and a semimonthly stream can share almost the
 * same *average* gap while looking very different in consistency).
 */
function classifyCadence(gapsDays: number[]): "weekly" | "biweekly" | "semimonthly" | "monthly" | null {
  if (gapsDays.length === 0) return null;
  const avg = gapsDays.reduce((sum, g) => sum + g, 0) / gapsDays.length;
  const maxDeviation = Math.max(...gapsDays.map((g) => Math.abs(g - avg)));
  if (avg >= 6 && avg <= 8 && maxDeviation <= 2) return "weekly";
  if (avg >= 27 && avg <= 32 && maxDeviation <= 4) return "monthly";
  if (avg >= 12 && avg <= 17) {
    if (maxDeviation <= 2) return "biweekly";
    if (maxDeviation <= 5) return "semimonthly";
  }
  return null;
}

const CADENCE_LABEL: Record<string, string> = {
  weekly: "week",
  biweekly: "2 weeks",
  semimonthly: "twice a month",
  monthly: "month",
};

/**
 * Read side of Phase 2 §52.2's financial aggregator — `PlaidAdapter` (connectors module) owns the
 * connect/sync/matching write path; this is just the query surface the UI needs. Deliberately owner-only,
 * no `ownerOrDelegatedHousehold`-style caregiver sharing the way commerce/documents/schedule have: raw
 * bank account balances and transactions are a materially more sensitive data class than a receipt or a
 * calendar event, and FAM-006's household-delegation scopes were never designed with "share my bank feed"
 * in mind — extending that here would need its own deliberate product decision, not a reflexive copy of
 * the pattern used everywhere else in this codebase.
 */
@Injectable()
export class FinanceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AttentionService) private readonly attention: AttentionService,
  ) {}

  /**
   * FIN-001 spec-conformance fix — `financialAccounts.name` is an `encryptedText` column (AES-256-GCM,
   * random IV per row per packages/db/src/crypto/field-encryption.ts), so a SQL-level `.orderBy(...name)`
   * sorts by random ciphertext bytes, not the account name — the list order was effectively random and
   * would shuffle on every request. Drizzle already decrypts each row via `fromDriver` before it reaches
   * this method, so the plaintext name is available in JS; sort there instead, after the query.
   *
   * FIN-005 — left-joins each account's liability row (absent for the common case of a non-liability
   * account, e.g. a checking account) so the account list UI can show minimum-payment/due-date detail per
   * credit-liability account without a second round trip, and gracefully renders nothing when `liability`
   * comes back null instead of treating that as an error.
   */
  async accounts(userId: string) {
    const rows = await this.db
      .select({ account: schema.financialAccounts, liability: schema.liabilities })
      .from(schema.financialAccounts)
      .leftJoin(schema.liabilities, eq(schema.liabilities.accountId, schema.financialAccounts.id))
      .where(eq(schema.financialAccounts.ownerUserId, userId));
    return rows
      .map((r) => ({ ...r.account, liability: r.liability ?? null }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async transactions(userId: string, accountId?: string) {
    return this.db
      .select()
      .from(schema.financialTransactions)
      .where(
        accountId
          ? and(eq(schema.financialTransactions.ownerUserId, userId), eq(schema.financialTransactions.accountId, accountId))
          : eq(schema.financialTransactions.ownerUserId, userId),
      )
      .orderBy(desc(schema.financialTransactions.postedDate));
  }

  /**
   * FIN-002 "preserve provider transaction ID history and transaction revisions" — the read side of
   * `PlaidAdapter`'s `transactionRevisions` writes (see that table's own schema doc comment for the two
   * edge cases it captures). Ownership is checked against `financial_transactions` first — the same
   * owner-only posture every other method on this service already has — even though
   * `transactionRevisions.financialTransactionId` isn't itself FK-constrained (so a stale/mutated id can't
   * accidentally leak another user's revision history by construction, but this check makes it explicit
   * rather than relying on that alone).
   */
  async transactionRevisions(transactionId: string, userId: string) {
    const [transaction] = await this.db
      .select({ id: schema.financialTransactions.id })
      .from(schema.financialTransactions)
      .where(and(eq(schema.financialTransactions.id, transactionId), eq(schema.financialTransactions.ownerUserId, userId)))
      .limit(1);
    if (!transaction) throw new NotFoundException({ code: "TRANSACTION_NOT_FOUND", message: "Transaction not found." });
    return this.db
      .select()
      .from(schema.transactionRevisions)
      .where(eq(schema.transactionRevisions.financialTransactionId, transactionId))
      .orderBy(desc(schema.transactionRevisions.createdAt));
  }

  async accountDetail(accountId: string, userId: string) {
    const [account] = await this.db
      .select()
      .from(schema.financialAccounts)
      .where(and(eq(schema.financialAccounts.id, accountId), eq(schema.financialAccounts.ownerUserId, userId)))
      .limit(1);
    if (!account) throw new NotFoundException({ code: "ACCOUNT_NOT_FOUND", message: "Account not found." });
    return account;
  }

  /**
   * FIN-001 "account list allows per-account inclusion/exclusion" — the write side of the toggle. Deliberately
   * a boolean PATCH rather than folding into a general account-update endpoint: nothing else about a
   * Plaid-sourced account (name, balance, type) is user-editable — it's mirrored from the institution — so
   * this is the one and only field a user can actually change here.
   */
  async setAccountIncluded(accountId: string, userId: string, isIncluded: boolean) {
    const account = await this.accountDetail(accountId, userId);
    await this.db
      .update(schema.financialAccounts)
      .set({ isIncluded, updatedAt: new Date() })
      .where(eq(schema.financialAccounts.id, accountId));
    return { ...account, isIncluded };
  }

  /**
   * FIN-001 "per-account inclusion/exclusion ... disappear from summaries" — the one place in this service
   * that actually sums account balances, so it's the one place that needs to respect `isIncluded`. Grouped
   * by currency rather than summed into one number: silently adding a USD balance to a EUR one would
   * misstate both (same "under-reporting is honest, mixing is not" stance as CommerceService's
   * savingsSummary currency guard).
   */
  async summary(userId: string) {
    const accounts = await this.db.select().from(schema.financialAccounts).where(eq(schema.financialAccounts.ownerUserId, userId));
    const included = accounts.filter((a) => a.isIncluded);
    const excluded = accounts.filter((a) => !a.isIncluded);
    const totalsByCurrency = new Map<string, number>();
    for (const account of included) {
      if (account.currentBalanceMinorUnits == null) continue;
      totalsByCurrency.set(account.currency, (totalsByCurrency.get(account.currency) ?? 0) + account.currentBalanceMinorUnits);
    }
    return {
      includedAccountCount: included.length,
      excludedAccountCount: excluded.length,
      totalsByCurrency: Array.from(totalsByCurrency.entries()).map(([currency, totalMinorUnits]) => ({ currency, totalMinorUnits })),
    };
  }

  /**
   * FIN-003 "Model paycheck ... as expected streams" — recomputes candidates live from raw transactions
   * (never trusts stale detection state as truth) and upserts each survivor into
   * `detected_income_streams` purely to give it a stable identity across scans, so a user's "not income"
   * dismissal (see dismissIncomeStream below) actually sticks instead of the same false positive
   * reappearing on the next call. Deliberately never looks at anything but POSITIVE deposits (Plaid
   * convention: negative amountMinorUnits = money IN) — an income-detection heuristic that could ever
   * flag an outgoing charge would be a materially worse mistake than simply missing a real paycheck.
   */
  async detectIncomeStreams(userId: string) {
    const deposits = await this.db
      .select()
      .from(schema.financialTransactions)
      .where(and(eq(schema.financialTransactions.ownerUserId, userId), eq(schema.financialTransactions.pending, false)));

    const groups = new Map<string, typeof deposits>();
    for (const txn of deposits) {
      if (txn.amountMinorUnits >= 0) continue; // not a deposit — Plaid convention, positive = money out
      if (!txn.postedDate) continue; // cadence detection needs a real date
      const key = `${txn.accountId}::${normalizeDescription(txn.name, txn.merchantName)}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(txn);
      groups.set(key, bucket);
    }

    const now = new Date();
    for (const [key, txns] of groups) {
      if (txns.length < INCOME_MIN_OCCURRENCES) continue;
      const amounts = txns.map((t) => Math.abs(t.amountMinorUnits));
      const med = median(amounts);
      const tolerant = txns.filter((t) => Math.abs(Math.abs(t.amountMinorUnits) - med) <= med * INCOME_AMOUNT_TOLERANCE);
      if (tolerant.length < INCOME_MIN_OCCURRENCES) continue;

      const sorted = [...tolerant].sort((a, b) => a.postedDate!.localeCompare(b.postedDate!));
      const gaps: number[] = [];
      for (let i = 1; i < sorted.length; i++) gaps.push(daysBetween(sorted[i - 1]!.postedDate!, sorted[i]!.postedDate!));
      const cadence = classifyCadence(gaps);
      if (!cadence) continue;

      // Split on the first "::" only — accountId is always a plain generated ID (never contains "::"),
      // but the normalized merchant/description half of the key theoretically could, so `.split("::")`
      // (which would silently drop everything after a second occurrence) isn't safe here.
      const sepIndex = key.indexOf("::");
      const accountId = key.slice(0, sepIndex);
      const streamKey = key.slice(sepIndex + 2);
      const latest = sorted[sorted.length - 1]!;
      const averageAmountMinorUnits = Math.round(tolerant.reduce((sum, t) => sum + Math.abs(t.amountMinorUnits), 0) / tolerant.length);

      const [existing] = await this.db
        .select()
        .from(schema.detectedIncomeStreams)
        .where(and(eq(schema.detectedIncomeStreams.accountId, accountId), eq(schema.detectedIncomeStreams.streamKey, streamKey)))
        .limit(1);
      const values = {
        description: latest.merchantName ?? latest.name,
        cadence,
        averageAmountMinorUnits,
        currency: latest.currency,
        occurrenceCount: tolerant.length,
        lastOccurrenceDate: latest.postedDate,
        updatedAt: now,
      };
      if (existing) {
        // Never touches dismissedAt — a user's "not income" correction must survive re-detection.
        await this.db.update(schema.detectedIncomeStreams).set(values).where(eq(schema.detectedIncomeStreams.id, existing.id));
      } else {
        await this.db.insert(schema.detectedIncomeStreams).values({
          id: generateId("detectedIncomeStream"),
          ownerUserId: userId,
          accountId,
          streamKey,
          dismissedAt: null,
          ...values,
        });
      }
    }

    const rows = await this.db
      .select()
      .from(schema.detectedIncomeStreams)
      .where(and(eq(schema.detectedIncomeStreams.ownerUserId, userId), isNull(schema.detectedIncomeStreams.dismissedAt)));
    return rows
      .map((r) => ({ ...r, cadenceLabel: CADENCE_LABEL[r.cadence] ?? r.cadence }))
      .sort((a, b) => (b.lastOccurrenceDate ?? "").localeCompare(a.lastOccurrenceDate ?? ""));
  }

  /** FIN-003 "confirm recurring stream / dismiss" — records that this user says a detected stream is not
   * actually income, so the next detectIncomeStreams call keeps recomputing its stats but stops surfacing
   * it. Ownership-checked the same way every other per-resource mutation in this service is. */
  async dismissIncomeStream(streamId: string, userId: string) {
    const [existing] = await this.db
      .select({ id: schema.detectedIncomeStreams.id })
      .from(schema.detectedIncomeStreams)
      .where(and(eq(schema.detectedIncomeStreams.id, streamId), eq(schema.detectedIncomeStreams.ownerUserId, userId)))
      .limit(1);
    if (!existing) throw new NotFoundException({ code: "INCOME_STREAM_NOT_FOUND", message: "Income stream not found." });
    await this.db.update(schema.detectedIncomeStreams).set({ dismissedAt: new Date(), updatedAt: new Date() }).where(eq(schema.detectedIncomeStreams.id, streamId));
    return { success: true };
  }

  /**
   * FIN-004 "Surface possible duplicate or unexpectedly different charge ... cautiously" — a periodic
   * scan (see worker-main.ts's attentionScanWorker, alongside AttentionService.scanAndFileDeadlines),
   * system-wide like every other scan in that file rather than per-user. Two independent, both
   * precision-first checks:
   *
   * 1. Duplicate: same account, same normalized merchant/description, the EXACT same amount, posted
   *    within DUPLICATE_CHARGE_WINDOW_DAYS of each other — never a "similar" amount, which is exactly the
   *    kind of fuzzy match that would make this noisy and untrustworthy.
   * 2. Unusual: a charge significantly above (>25%, mirroring CommerceService.computeBillBaseline's own
   *    threshold) this merchant's own historical average for this owner.
   *
   * Both only ever look at non-pending, positive (money-out) transactions — a pending amount can still
   * change before it posts, and a deposit is never a "charge" to begin with.
   */
  async detectAnomalousTransactions(): Promise<void> {
    const lookbackCutoff = new Date(Date.now() - ANOMALY_SCAN_LOOKBACK_DAYS * 86_400_000).toISOString().slice(0, 10);
    const recentCharges = await this.db
      .select()
      .from(schema.financialTransactions)
      .where(and(eq(schema.financialTransactions.pending, false), gte(schema.financialTransactions.postedDate, lookbackCutoff)));

    // --- 1. Duplicate charges -------------------------------------------------------------------------
    const byAccountMerchantAmount = new Map<string, typeof recentCharges>();
    for (const txn of recentCharges) {
      if (txn.amountMinorUnits <= 0 || !txn.postedDate) continue; // not a real outgoing charge
      const key = `${txn.accountId}::${normalizeDescription(txn.name, txn.merchantName)}::${txn.amountMinorUnits}`;
      const bucket = byAccountMerchantAmount.get(key) ?? [];
      bucket.push(txn);
      byAccountMerchantAmount.set(key, bucket);
    }
    for (const bucket of byAccountMerchantAmount.values()) {
      if (bucket.length < 2) continue;
      const sorted = [...bucket].sort((a, b) => a.postedDate!.localeCompare(b.postedDate!));
      for (let i = 1; i < sorted.length; i++) {
        const prior = sorted[i - 1]!;
        const dupe = sorted[i]!;
        if (daysBetween(prior.postedDate!, dupe.postedDate!) > DUPLICATE_CHARGE_WINDOW_DAYS) continue;
        const merchantLabel = dupe.merchantName ?? dupe.name;
        const amountText = (dupe.amountMinorUnits / 100).toFixed(2);
        await this.attention.fileIfNew({
          ownerUserId: dupe.ownerUserId,
          householdId: null,
          reasonCode: "financial_duplicate_charge",
          reasonText: `This $${amountText} charge to ${merchantLabel} happened twice within a day — might be a duplicate.`,
          urgency: "important",
          dueAt: null,
          dueAtSort: new Date(`${dupe.postedDate}T00:00:00Z`),
          moneyAtStakeMinorUnits: dupe.amountMinorUnits,
          moneyAtStakeCurrency: dupe.currency,
          confidenceBand: "needs_review",
          linkedResourceType: "financial_duplicate_charge",
          linkedResourceId: dupe.id,
          primaryActions: ["looks_right", "dispute_with_bank"],
        });
      }
    }

    // --- 2. Unusually high charge vs this merchant's own history --------------------------------------
    for (const txn of recentCharges) {
      if (txn.amountMinorUnits <= 0 || !txn.postedDate) continue;
      const normalized = normalizeDescription(txn.name, txn.merchantName);
      const ownersTransactions = await this.db
        .select()
        .from(schema.financialTransactions)
        .where(and(eq(schema.financialTransactions.ownerUserId, txn.ownerUserId), eq(schema.financialTransactions.pending, false), ne(schema.financialTransactions.id, txn.id)));
      const priorCharges = ownersTransactions
        .filter(
          (t) =>
            t.amountMinorUnits > 0 &&
            t.currency === txn.currency &&
            t.postedDate != null &&
            t.postedDate < txn.postedDate! &&
            normalizeDescription(t.name, t.merchantName) === normalized,
        )
        .sort((a, b) => b.postedDate!.localeCompare(a.postedDate!))
        .slice(0, TRANSACTION_BASELINE_MAX_SAMPLE);
      if (priorCharges.length < TRANSACTION_BASELINE_MIN_SAMPLE) continue;

      const averageMinorUnits = Math.round(priorCharges.reduce((sum, t) => sum + t.amountMinorUnits, 0) / priorCharges.length);
      const percentAboveBaseline = averageMinorUnits > 0 ? (txn.amountMinorUnits - averageMinorUnits) / averageMinorUnits : 0;
      if (percentAboveBaseline <= TRANSACTION_BASELINE_SIGNIFICANT_THRESHOLD) continue;

      const merchantLabel = txn.merchantName ?? txn.name;
      await this.attention.fileIfNew({
        ownerUserId: txn.ownerUserId,
        householdId: null,
        reasonCode: "financial_unusual_charge",
        reasonText: `This charge is unusually high for ${merchantLabel} compared to your history.`,
        urgency: "important",
        dueAt: null,
        dueAtSort: new Date(`${txn.postedDate}T00:00:00Z`),
        moneyAtStakeMinorUnits: txn.amountMinorUnits,
        moneyAtStakeCurrency: txn.currency,
        confidenceBand: "needs_review",
        linkedResourceType: "financial_unusual_charge",
        linkedResourceId: txn.id,
        primaryActions: ["looks_right", "dispute_with_bank"],
      });
    }
  }
}
