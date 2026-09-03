import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { temporalToSortDate, defaultReminderMinutes } from "../ingestion/temporal.util";
import { HouseholdService } from "../household/household.service";
import { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import { identityRecordSafeColumns } from "../identity-records/identity-records.util";
import { IDENTITY_RECORD_TYPE_LABELS, type IdentityRecordType } from "../identity-records/dto";
import { EVENT_BUS, type EventBus } from "../../events/event-bus.interface";

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
// BILL-002 "if expected payment fails to appear, alert after sensible grace period" — a bill isn't
// actually late the instant its due date passes (checks clear, autopay posts a day or two later), so
// escalating to an overdue alert waits this long past dueDateSort. Bounded on the other end (see
// OVERDUE_LOOKBACK_MS below) so a bill from months ago that was simply never marked paid doesn't
// resurface forever.
const BILL_GRACE_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
const OVERDUE_LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;

function daysUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
}

function urgencyFor(days: number): "critical" | "important" | "useful" {
  if (days <= 3) return "critical";
  if (days <= 7) return "important";
  return "useful";
}

// HOME-001 "Attention engine scores candidates using urgency, severity, certainty, user preference,
// consequence, money at risk, household dependencies, notification history, and duplicate suppression" —
// found live via this audit: `home()` below previously just ordered the whole queue by `dueAtSort`
// ascending with nothing downstream re-ranking it (confirmed live on both web and mobile — neither client
// re-sorts the `items` array it's handed), so two items due on the same day never differentiated on
// urgency tier, money at stake, or confidence at all, and a "useful" item due tomorrow silently outranked
// a "critical" item due later the same week whenever their due timestamps happened to interleave (e.g. a
// $10 warranty expiring in 2 days sorted ABOVE a $600 bill due in 3 days, even though bill-urgency
// escalates faster — urgencyFor(2)="critical" for the warranty too, so same tier, but a same-tier item with
// nothing at stake still isn't more "needs you" than one with real money on the line). This doesn't
// implement every input the spec lists (user preference/household dependencies/notification history feed
// the notification layer, not this synchronous read — see notification-delivery.service.ts), but it does
// give the ranked queue a real composite ordering instead of a single raw column: urgency tier first
// (critical/important/useful — the plain-language severity a user reads on each card), then confidence
// (verified/high-confidence items before a needs-review one, since a self-service action on unconfirmed
// data is the exact case that should wait for its own promotion rather than jump the queue), then money at
// stake (more to lose ranks higher within the same tier), and only then due date as the final tiebreaker.
const URGENCY_RANK: Record<string, number> = { critical: 0, important: 1, useful: 2 };
const CONFIDENCE_RANK: Record<string, number> = { verified: 0, high: 0, needs_review: 1, approximate: 1, conflicting: 1 };

function priorityKey(item: {
  urgency: string;
  confidenceBand: string;
  moneyAtStakeMinorUnits: number | null;
  dueAtSort: Date | null;
}): [number, number, number, number] {
  return [
    URGENCY_RANK[item.urgency] ?? 3,
    CONFIDENCE_RANK[item.confidenceBand] ?? 1,
    -(item.moneyAtStakeMinorUnits ?? 0),
    item.dueAtSort ? item.dueAtSort.getTime() : Number.MAX_SAFE_INTEGER,
  ];
}

function comparePriority(a: ReturnType<typeof priorityKey>, b: ReturnType<typeof priorityKey>): number {
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function money(minorUnits: number, currency: string): string {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

/**
 * CAL-002 "reminder defaults" wording helper — every other deadline scanned in this file is at least a
 * day out by the time it's filed (BILL_GRACE_PERIOD_MS/OVERDUE_LOOKBACK_MS etc. all operate in whole
 * days), so `daysUntil`'s "in N days" phrasing works everywhere else in this class. A calendar event's
 * reminder lead time is commonly well under a day (the default for a timed event is 60 minutes — see
 * ingestion/temporal.util.ts's defaultReminderMinutes), where "in 0 days" would be a useless/wrong-looking
 * reminder, so this scan gets its own minutes/hours/days phrasing instead of reusing daysUntil.
 */
function relativeTimeText(target: Date, now: Date): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? "" : "s"}`;
}

export interface ScannedAttentionItem {
  ownerUserId: string;
  householdId: string | null;
  reasonCode: string;
  reasonText: string;
  urgency: "critical" | "important" | "useful";
  dueAt: TemporalValue | null;
  dueAtSort: Date;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  confidenceBand: string;
  linkedResourceType: string;
  linkedResourceId: string;
  primaryActions: string[];
}

@Injectable()
export class AttentionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(NotificationDeliveryService) private readonly notifications: NotificationDeliveryService,
    // §42.3/42.4 domain event taxonomy — appended last and typed optional so every pre-existing
    // `new AttentionService(...)` positional test construction (this module's own test suite has dozens)
    // keeps compiling unchanged, same "optional trailing constructor param" convention
    // IngestionService already uses for every dependency added after its original build. Undefined only in
    // tests constructed positionally without it, in which case `this.events?.emit(...)` in
    // `insertAttentionItem` below is simply a no-op — an attention item still gets filed exactly as
    // before, just not (yet) reflected on the event bus. EventBusModule is `@Global()`, so it's always
    // really injected outside a positional test.
    @Inject(EVENT_BUS) private readonly events?: EventBus,
  ) {}

  /**
   * HOME-002 "Today view" — found live via this audit: the only "today" surface anywhere (the Home
   * screen's "Household — Today" card, backed by HouseholdService.today) requires the caller to already
   * belong to a household, so a solo account — confirmed live by hitting this as a fresh sign-up with no
   * household — got literally no today-window view at all, on either web or mobile, despite HOME-002
   * being a Core (not household-gated) requirement. It also only ever merged calendar events + tasks +
   * attention items, omitting two of the spec's own listed categories that already have real tables:
   * "due bills" and "deliveries".
   *
   * This is a personal (not household-scoped) merge for the current calendar day in UTC, covering the
   * four domains here that have a real, queryable due/start date today: calendar events, open tasks due
   * today, bills due today, and shipments/deliveries expected today. "Travel milestones", "school/family
   * obligations", and "location reminders" have no backing table anywhere in this codebase (no
   * trip_segments table exists) — deliberately left out rather than faked, same stance as this module's
   * other "don't invent what isn't there" comments.
   *
   * Scope is deliberately the union of the user's own rows and any active household's shared rows (the
   * same ownerOrDelegatedHousehold shape ScheduleService/CommerceService already use elsewhere) — a
   * household member still sees their own personal today-view merged with shared household items, not a
   * second separate list. Shipments have no `estimatedDeliverySort` column (no sort column at all for
   * that field — see commerce.ts's schema), so unlike the other three domains this filters in application
   * code after decrypting/parsing the temporal value, rather than in SQL.
   */
  async personalToday(userId: string) {
    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const householdIds = await this.households.activeHouseholdIds(userId);
    const ownerOrHousehold = (ownerCol: AnyPgColumn, householdCol: AnyPgColumn) =>
      householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);

    const events = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(
        and(
          ownerOrHousehold(schema.calendarEvents.ownerUserId, schema.calendarEvents.householdId),
          or(ne(schema.calendarEvents.visibility, "private"), eq(schema.calendarEvents.ownerUserId, userId))!,
          isNotNull(schema.calendarEvents.startSort),
          gte(schema.calendarEvents.startSort, startOfDay),
          lte(schema.calendarEvents.startSort, endOfDay),
        ),
      )
      .orderBy(asc(schema.calendarEvents.startSort));

    const tasks = await this.db
      .select()
      .from(schema.tasks)
      .where(
        and(
          or(ownerOrHousehold(schema.tasks.ownerUserId, schema.tasks.householdId), eq(schema.tasks.assignedToUserId, userId))!,
          ne(schema.tasks.state, "completed"),
          ne(schema.tasks.state, "dismissed"),
          isNotNull(schema.tasks.dueSort),
          lte(schema.tasks.dueSort, endOfDay),
        ),
      )
      .orderBy(asc(schema.tasks.dueSort));

    const bills = await this.db
      .select()
      .from(schema.bills)
      .where(
        and(
          ownerOrHousehold(schema.bills.ownerUserId, schema.bills.householdId),
          isNotNull(schema.bills.dueDateSort),
          gte(schema.bills.dueDateSort, startOfDay),
          lte(schema.bills.dueDateSort, endOfDay),
        ),
      )
      .orderBy(asc(schema.bills.dueDateSort));

    // shipments has no householdId column at all (see commerce.ts's schema doc comment — a tracking
    // number isn't globally unique, so ownership lives directly on the row), so this is owner-only, unlike
    // the three domains above.
    const candidateShipments = await this.db
      .select()
      .from(schema.shipments)
      .where(and(eq(schema.shipments.ownerUserId, userId), ne(schema.shipments.status, "delivered")));
    const deliveries = candidateShipments.filter((s) => {
      if (!s.estimatedDelivery) return false;
      const sort = temporalToSortDate(s.estimatedDelivery);
      return sort != null && sort >= startOfDay && sort <= endOfDay;
    });

    return { events, tasks, bills, deliveries };
  }

  /**
   * HOME-001/004 — the ranked "Needs You" queue plus the caught-up/degraded state computation. Ordered by
   * `dueAtSort` at the SQL level purely as a stable initial fetch order; the real composite ranking
   * (urgency tier -> confidence -> money at stake -> due date — see `priorityKey`'s doc comment above) is
   * applied in application code afterward, same "decrypt/fetch then rank" shape this module already uses
   * elsewhere for anything that can't be expressed as a single SQL ORDER BY column.
   *
   * Round-3 integration-audit fix: this used to filter strictly by `ownerUserId`, so a household-shared
   * bill/warranty/pet-vaccination/return deadline — `scanAndFileDeadlines` above already stamps the
   * correct `householdId` on every row it files — silently never appeared in any OTHER household member's
   * queue, even though the exact same data is already visible to them via the underlying domain's own
   * list endpoint (bills/warranties/pets all OR in household membership). Confirmed live: a bill filed
   * for a shared household showed up in the filer's own `/v1/home` but came back `caughtUp: true` for a
   * second active member of that same household. Fixed the same way `personalToday` just above already
   * does it (its own doc comment: "the same ownerOrDelegatedHousehold shape ScheduleService/CommerceService
   * already use elsewhere") — OR in plain active household membership, not a delegation scope: an
   * attention item aggregates many domains (bills/warranties/pets/returns/travel/etc.), each with its own
   * delegation scope, so there's no single scope to check here; a household member already sees the
   * underlying row via that domain's own endpoint regardless of delegation, and `personalToday` sets the
   * precedent that this aggregation layer follows plain membership, not per-domain delegation. Deliberately
   * NOT extended to `resolve`/`dismiss` (still owner-only via `assertOwned`) — letting a member see a
   * shared deadline is safe by default; letting them dismiss another member's item is a separate authorization
   * question this fix doesn't need to answer to close the visibility gap.
   */
  async home(userId: string) {
    const householdIds = await this.households.activeHouseholdIds(userId);
    const ownerOrHousehold =
      householdIds.length > 0
        ? or(eq(schema.attentionItems.ownerUserId, userId), inArray(schema.attentionItems.householdId, householdIds))!
        : eq(schema.attentionItems.ownerUserId, userId);
    const rows = await this.db
      .select()
      .from(schema.attentionItems)
      .where(and(ownerOrHousehold, eq(schema.attentionItems.resolved, false)))
      .orderBy(asc(schema.attentionItems.dueAtSort));

    const items = [...rows].sort((a, b) => comparePriority(priorityKey(a), priorityKey(b)));

    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, userId));
    const unhealthyConnections = connections.filter((c) => !["healthy", "initializing"].includes(c.health));

    return {
      items,
      caughtUp: items.length === 0,
      degraded: unhealthyConnections.length > 0,
      unhealthyConnections: unhealthyConnections.map((c) => ({ id: c.id, provider: c.provider, health: c.health })),
    };
  }

  async resolve(id: string, userId: string) {
    await this.assertOwned(id, userId);
    await this.db.update(schema.attentionItems).set({ resolved: true, updatedAt: new Date() }).where(eq(schema.attentionItems.id, id));
  }

  async dismiss(id: string, userId: string, reason: string) {
    await this.assertOwned(id, userId);
    await this.db
      .update(schema.attentionItems)
      .set({ resolved: true, dismissedReason: reason, updatedAt: new Date() })
      .where(eq(schema.attentionItems.id, id));
  }

  /**
   * §HOME-001/004's actual writer — previously attention_items had zero real inserters anywhere in the
   * app (only seed data), so Home's "Needs You" queue silently stayed permanently empty/caught-up for
   * every real account regardless of what actually needed attention. Called by a recurring worker tick
   * (see queue-producer.service.ts/worker-main.ts), not a request path — this is background filing, not
   * something a user action triggers.
   *
   * Deliberately narrow: files upcoming (not yet passed, not overdue) bill/return/warranty deadlines
   * within a 14-day lookahead, and — critically — checks for ANY existing attention_item for that exact
   * linked resource (regardless of resolved state) before inserting, so a user who already dismissed or
   * resolved one doesn't have it silently reappear on the next tick. Bills are the one domain with a real
   * "paid" signal today (bills.paymentObservedTransactionId, stamped by PlaidAdapter.matchTransaction),
   * so they get the fuller treatment below: a bill already paid never files "due soon" in the first
   * place, and an unpaid bill past its due date (plus a grace period) escalates from "due soon" to
   * "overdue" via fileOrEscalate — still never auto-resolving an item the user already dismissed/resolved.
   * Returns now have an equivalent signal too — PlaidAdapter.matchTransaction's refund-matching block also
   * flips returnCases.state to "resolved" once a matching refund transaction is observed (see its own doc
   * comment), and the `eq(schema.returnCases.state, "eligible")` filter below already excludes those from
   * ever filing a NEW "return window closing" item, the same practical effect as the bill block's
   * `paymentObservedTransactionId` check. Warranties still have no equivalent "handled" signal, so they
   * keep the original due-soon-only, never-overdue behavior.
   */
  async scanAndFileDeadlines(): Promise<void> {
    const now = new Date();
    const lookahead = new Date(now.getTime() + LOOKAHEAD_MS);
    const inWindow = (col: AnyPgColumn) => and(isNotNull(col), gte(col, now), lte(col, lookahead))!;

    const bills = await this.db.select().from(schema.bills).where(inWindow(schema.bills.dueDateSort));
    for (const bill of bills) {
      // BILL-002 "distinguish 'due' from 'likely handled'" — PlaidAdapter.matchTransaction already
      // stamps paymentObservedTransactionId once a posted transaction matches this bill; filing "due in
      // N days" for a bill that's already been paid (e.g. autopay posted early) would be actively wrong,
      // not just stale.
      if (bill.paymentObservedTransactionId) continue;
      const days = daysUntil(bill.dueDateSort!, now);
      const amount = bill.amountDueMinorUnits != null && bill.amountDueCurrency ? ` of ${money(bill.amountDueMinorUnits, bill.amountDueCurrency)}` : "";
      await this.fileIfNew({
        ownerUserId: bill.ownerUserId,
        householdId: bill.householdId,
        reasonCode: "bill_due",
        reasonText: `${bill.billerLabel} bill${amount} is due in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: bill.dueDate,
        dueAtSort: bill.dueDateSort!,
        moneyAtStakeMinorUnits: bill.amountDueMinorUnits,
        moneyAtStakeCurrency: bill.amountDueCurrency,
        confidenceBand: "verified",
        linkedResourceType: "bill",
        linkedResourceId: bill.id,
        primaryActions: ["mark_paid", "open_biller"],
      });
    }

    // BILL-002 "if expected payment fails to appear, alert after sensible grace period" — this is the
    // other half of the distinction above: a bill whose due date has now passed the grace period with no
    // matched transaction gets escalated from "due soon" to "overdue". Found live while auditing §18: the
    // schema (bills.paymentObservedTransactionId) and the writer (PlaidAdapter.matchTransaction) already
    // existed, but nothing ever read the "still unpaid past due" side of that signal — an unpaid bill
    // just silently aged out of the 14-day lookahead window above with no follow-up.
    const overdueCutoff = new Date(now.getTime() - BILL_GRACE_PERIOD_MS);
    const overdueLookback = new Date(now.getTime() - OVERDUE_LOOKBACK_MS);
    const overdueBills = await this.db
      .select()
      .from(schema.bills)
      .where(
        and(
          isNotNull(schema.bills.dueDateSort),
          lte(schema.bills.dueDateSort, overdueCutoff),
          gte(schema.bills.dueDateSort, overdueLookback),
          isNull(schema.bills.paymentObservedTransactionId),
        ),
      );
    for (const bill of overdueBills) {
      const daysLate = Math.max(1, Math.ceil((now.getTime() - bill.dueDateSort!.getTime()) / 86_400_000));
      const amount = bill.amountDueMinorUnits != null && bill.amountDueCurrency ? ` of ${money(bill.amountDueMinorUnits, bill.amountDueCurrency)}` : "";
      await this.fileOrEscalate(
        {
          ownerUserId: bill.ownerUserId,
          householdId: bill.householdId,
          reasonCode: "bill_overdue",
          reasonText: `${bill.billerLabel} bill${amount} was due ${daysLate} day${daysLate === 1 ? "" : "s"} ago and no payment has been observed yet.`,
          urgency: "critical",
          dueAt: bill.dueDate,
          dueAtSort: bill.dueDateSort!,
          moneyAtStakeMinorUnits: bill.amountDueMinorUnits,
          moneyAtStakeCurrency: bill.amountDueCurrency,
          confidenceBand: "verified",
          linkedResourceType: "bill",
          linkedResourceId: bill.id,
          primaryActions: ["mark_paid", "open_biller"],
        },
        ["bill_due"],
      );
    }

    // CAL-002 "reminder defaults" — the actual notification-producing counterpart to
    // `calendarEvents.reminderMinutesBefore`; before this, the column existed nowhere and nothing ever
    // reminded a user about an upcoming appointment/reservation at all. Fetches everything starting within
    // the normal 14-day lookahead (a lead time longer than that would be unusual — see the web/mobile
    // reminder pickers' capped option lists) and, like `deliveries` above, filters by the per-row lead time
    // in application code rather than SQL, since `reminderMinutesBefore` varies row to row. A cancelled
    // event (status "cancelled" — set by e.g. a provider-side cancellation sync) is excluded; there's
    // nothing useful to remind the user about a meeting that no longer exists.
    const candidateEvents = await this.db
      .select()
      .from(schema.calendarEvents)
      .where(and(isNotNull(schema.calendarEvents.startSort), gte(schema.calendarEvents.startSort, now), lte(schema.calendarEvents.startSort, lookahead)));
    for (const event of candidateEvents) {
      if (event.status === "cancelled") continue;
      const leadMinutes = event.reminderMinutesBefore ?? defaultReminderMinutes(event.isAllDay);
      const remindAt = new Date(event.startSort!.getTime() - leadMinutes * 60_000);
      if (remindAt > now) continue; // not yet time to remind — will be picked up by a later tick
      await this.fileIfNew({
        ownerUserId: event.ownerUserId,
        householdId: event.householdId,
        reasonCode: "event_reminder",
        reasonText: `${event.title} ${event.isAllDay ? "is" : "starts"} ${relativeTimeText(event.startSort!, now)}${event.location ? ` at ${event.location}` : ""}.`,
        urgency: leadMinutes <= 60 ? "important" : "useful",
        dueAt: event.start,
        dueAtSort: event.startSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "calendar_event",
        linkedResourceId: event.id,
        primaryActions: ["view_event"],
      });
    }

    // SUB-002 "creates opportunity before charged renewal ... asks user whether they want to
    // keep/cancel/decide later" — mirrors the bill/return/warranty deadline scans above; found live
    // while auditing §18 that subscriptions.trialEndsAt was captured by extraction (see
    // IngestionService.extractSubscription) but nothing downstream of it ever surfaced a trial-ending
    // warning — a trial looked identical to any other subscription until it silently converted.
    // trialEndsAt has no dedicated sort column (unlike dueDateSort/deadlineSort/expirationDateSort on
    // other tables), so the window check happens in application code via temporalToSortDate, same as
    // extractSubscription itself does when it first parses the date out of an email.
    const trialSubs = await this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(and(eq(schema.subscriptions.state, "trial"), isNotNull(schema.subscriptions.trialEndsAt)));
    for (const row of trialSubs) {
      const trialEndsSort = temporalToSortDate(row.subscription.trialEndsAt!);
      if (!trialEndsSort || trialEndsSort < now || trialEndsSort > lookahead) continue;
      const days = daysUntil(trialEndsSort, now);
      const amount =
        row.stream.typicalAmountMinorUnits != null && row.stream.typicalAmountCurrency
          ? ` (${money(row.stream.typicalAmountMinorUnits, row.stream.typicalAmountCurrency)}/${row.stream.cadence})`
          : "";
      await this.fileIfNew({
        ownerUserId: row.stream.ownerUserId,
        householdId: row.stream.householdId,
        reasonCode: "trial_ending",
        reasonText: `${row.stream.serviceLabel} trial ends in ${days} day${days === 1 ? "" : "s"}${amount} — keep, cancel, or decide later.`,
        urgency: urgencyFor(days),
        dueAt: row.subscription.trialEndsAt,
        dueAtSort: trialEndsSort,
        moneyAtStakeMinorUnits: row.stream.typicalAmountMinorUnits,
        moneyAtStakeCurrency: row.stream.typicalAmountCurrency,
        confidenceBand: "verified",
        linkedResourceType: "subscription",
        linkedResourceId: row.subscription.id,
        primaryActions: ["keep", "cancel_assist", "decide_later"],
      });
    }

    const returns = await this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases, merchant: schema.merchants })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
      .where(and(inWindow(schema.returnCases.deadlineSort), eq(schema.returnCases.state, "eligible")));
    for (const row of returns) {
      const days = daysUntil(row.returnCase.deadlineSort!, now);
      const merchantLabel = row.merchant?.displayName ?? "your order";
      const value =
        row.returnCase.valueAtStakeMinorUnits != null && row.returnCase.valueAtStakeCurrency
          ? ` (${money(row.returnCase.valueAtStakeMinorUnits, row.returnCase.valueAtStakeCurrency)} at stake)`
          : "";
      await this.fileIfNew({
        ownerUserId: row.purchase.ownerUserId,
        householdId: row.purchase.householdId,
        reasonCode: "return_window_closing",
        reasonText: `Return window for ${merchantLabel} closes in ${days} day${days === 1 ? "" : "s"}${value}.`,
        urgency: urgencyFor(days),
        dueAt: row.returnCase.deadline,
        dueAtSort: row.returnCase.deadlineSort!,
        moneyAtStakeMinorUnits: row.returnCase.valueAtStakeMinorUnits,
        moneyAtStakeCurrency: row.returnCase.valueAtStakeCurrency,
        confidenceBand: "verified",
        linkedResourceType: "return_case",
        linkedResourceId: row.returnCase.id,
        primaryActions: ["start_return", "keep_item"],
      });
    }

    const warranties = await this.db.select().from(schema.warranties).where(inWindow(schema.warranties.expirationDateSort));
    for (const warranty of warranties) {
      const days = daysUntil(warranty.expirationDateSort!, now);
      await this.fileIfNew({
        ownerUserId: warranty.ownerUserId,
        householdId: warranty.householdId,
        reasonCode: "warranty_expiring",
        reasonText: `Warranty on ${warranty.productLabel} expires in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: warranty.expirationDate,
        dueAtSort: warranty.expirationDateSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "warranty",
        linkedResourceId: warranty.id,
        primaryActions: ["review"],
      });
    }

    // UTIL-001 "equipment return obligations ... from source messages where available" — the deadline
    // counterpart to `bills.equipmentReturnDeadline` (see IngestionService.extractBill and
    // packages/db/src/schema/commerce.ts's own doc comment): explicit-only, since it's only ever populated
    // from a literal statement in a bill/cancellation email, never inferred. Mirrors the bill-due scan
    // above's shape, just keyed off a different date column on the same table.
    //
    // Deliberately files under its own `linkedResourceType` ("bill_equipment_return") rather than "bill" —
    // `fileIfNew`'s dedup lookup keys purely on (linkedResourceType, linkedResourceId), with no reasonCode
    // in that key (see its own doc comment above), so reusing "bill" here would silently collide with
    // whichever of bill_due/bill_overdue already filed first for the exact same bill row and this equipment-
    // return reminder would simply never be created — a genuinely different obligation with its own
    // independent due date needs its own dedup key, not a shared one just because it originates from the
    // same underlying row.
    const equipmentReturns = await this.db.select().from(schema.bills).where(inWindow(schema.bills.equipmentReturnDeadlineSort));
    for (const bill of equipmentReturns) {
      const days = daysUntil(bill.equipmentReturnDeadlineSort!, now);
      await this.fileIfNew({
        ownerUserId: bill.ownerUserId,
        householdId: bill.householdId,
        reasonCode: "equipment_return_due",
        reasonText: `Return your ${bill.billerLabel} equipment in ${days} day${days === 1 ? "" : "s"} to avoid an unreturned-equipment charge.`,
        urgency: urgencyFor(days),
        dueAt: bill.equipmentReturnDeadline,
        dueAtSort: bill.equipmentReturnDeadlineSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "bill_equipment_return",
        linkedResourceId: bill.id,
        primaryActions: ["view_bill"],
      });
    }

    // VEH-006/HOMEOS-008 — an unresolved recall (a fresh automated match, or one the user already
    // confirmed genuinely applies) becomes an attention item, exactly once per match — same "any existing
    // item for this resource, regardless of resolved state" fileIfNew semantics as every other domain
    // scanned above, so a match the user already dismissed the resulting attention item for doesn't
    // reappear on the next hourly tick just because recall_matches itself is still unresolved. Not
    // time-windowed like the deadline scans above (a recall has no future due date to look ahead to — it's
    // either unresolved right now or it isn't), mirroring trialSubs' identical "scan by state, not by
    // date-in-window" shape elsewhere in this method.
    const openRecalls = await this.db
      .select({ recall: schema.recallMatches, vehicle: schema.vehicleProfiles, homeAsset: schema.homeAssets })
      .from(schema.recallMatches)
      .leftJoin(schema.vehicleProfiles, eq(schema.vehicleProfiles.id, schema.recallMatches.vehicleProfileId))
      .leftJoin(schema.homeAssets, eq(schema.homeAssets.id, schema.recallMatches.homeAssetId))
      .where(ne(schema.recallMatches.status, "closed_or_repaired"));
    for (const row of openRecalls) {
      const ownerUserId = row.vehicle?.ownerUserId ?? row.homeAsset?.ownerUserId;
      if (!ownerUserId) continue; // orphaned match — its subject was deleted without the FK cascade running yet; nothing to notify
      const subjectLabel = row.vehicle?.label ?? row.homeAsset?.label ?? "your vehicle/home asset";
      const isConfirmed = row.recall.status === "open"; // user already verified this applies — see RecallMonitorService's own doc comment on why the scanner itself never sets this
      const what = row.recall.component ?? row.recall.summary.slice(0, 100);
      await this.fileIfNew({
        ownerUserId,
        householdId: row.vehicle?.householdId ?? null, // homeAssets has no householdId column of its own — it's scoped via its parent property instead
        reasonCode: row.vehicle ? "vehicle_recall" : "home_asset_recall",
        reasonText: isConfirmed
          ? `Confirmed recall on ${subjectLabel}: ${what}.`
          : `Potential recall on ${subjectLabel}: ${what} — verify this affects your specific ${row.vehicle ? "VIN" : "unit"}.`,
        urgency: isConfirmed ? "critical" : "important",
        dueAt: null,
        dueAtSort: row.recall.checkedAt,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: isConfirmed ? "verified" : "needs_review",
        linkedResourceType: "recall_match",
        linkedResourceId: row.recall.id,
        primaryActions: row.vehicle ? ["view_vehicle"] : ["view_property"],
      });
    }

    // CRED-001 "Credits and stored value" — "Opportunity view shows balance/value, expiration...". Found
    // missing during an audit pass: the comment on the travelCredits scan below always claimed to mirror
    // "the exact same expiration-alert pattern as storeCredits/warranties above," but no storeCredits scan
    // ever actually existed — a store credit could silently expire with zero warning. Mirrors the
    // warranties scan's shape exactly, plus a `redeemed` skip matching travelCredits' own below.
    const storeCredits = await this.db
      .select({ credit: schema.storeCredits, merchant: schema.merchants })
      .from(schema.storeCredits)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.storeCredits.merchantId))
      .where(inWindow(schema.storeCredits.expirationDateSort));
    for (const row of storeCredits) {
      if (row.credit.redeemed) continue;
      const days = daysUntil(row.credit.expirationDateSort!, now);
      const amount = money(row.credit.amountMinorUnits, row.credit.currency);
      const merchantLabel = row.merchant?.displayName ?? "store";
      await this.fileIfNew({
        ownerUserId: row.credit.ownerUserId,
        householdId: row.credit.householdId,
        reasonCode: "store_credit_expiring",
        reasonText: `Your ${merchantLabel} store credit of ${amount} expires in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: row.credit.expirationDate,
        dueAtSort: row.credit.expirationDateSort!,
        moneyAtStakeMinorUnits: row.credit.amountMinorUnits,
        moneyAtStakeCurrency: row.credit.currency,
        confidenceBand: "verified",
        linkedResourceType: "store_credit",
        linkedResourceId: row.credit.id,
        primaryActions: ["mark_used", "view_purchase"],
      });
    }

    // TRIP-007 "Cancellation and credit tracking" — "Expiring value enters opportunity engine." Reuses
    // the exact same expiration-alert pattern as storeCredits/warranties above.
    const travelCredits = await this.db.select().from(schema.travelCredits).where(inWindow(schema.travelCredits.expirationDateSort));
    for (const credit of travelCredits) {
      if (credit.redeemed) continue;
      const days = daysUntil(credit.expirationDateSort!, now);
      const amount = money(credit.amountMinorUnits, credit.currency);
      await this.fileIfNew({
        ownerUserId: credit.ownerUserId,
        householdId: credit.householdId,
        reasonCode: "travel_credit_expiring",
        reasonText: `Your ${credit.providerName ?? "travel"} credit of ${amount} expires in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: credit.expirationDate,
        dueAtSort: credit.expirationDateSort!,
        moneyAtStakeMinorUnits: credit.amountMinorUnits,
        moneyAtStakeCurrency: credit.currency,
        confidenceBand: "verified",
        linkedResourceType: "travel_credit",
        linkedResourceId: credit.id,
        primaryActions: ["mark_used", "view_trip"],
      });
    }

    // TRIP-006 "Travel document readiness" — compares a passport-kind document's expiry against upcoming
    // trip dates. Never asserts a jurisdiction-specific visa/validity rule (spec: "Life Inbox does not
    // invent visa/validity requirements") — only ever a reminder to verify entry requirements yourself.
    // "Soon after" uses a ~6-month heuristic window many destinations informally expect, explicitly framed
    // as "verify yourself," never asserted as a real rule for any specific destination.
    const upcomingTrips = await this.db
      .select()
      .from(schema.trips)
      .where(and(isNotNull(schema.trips.startDateSort), gte(schema.trips.startDateSort, now), lte(schema.trips.startDateSort, lookahead), ne(schema.trips.status, "cancelled"), isNull(schema.trips.deletedAt)));
    const SIX_MONTHS_MS = 182 * 86_400_000;
    for (const trip of upcomingTrips) {
      const tripEnd = trip.endDateSort ?? trip.startDateSort!;
      // "Identity & Legal Continuity" (ID-001) gives passports a dedicated, more-authoritative record than
      // this generic Documents-vault `documentKind==="passport"` fallback (built earlier, before that domain
      // existed) — prefer `identity_records` when the owner has at least one dedicated, still-current
      // passport record, but keep this exact fallback for a user who hasn't added one, so nothing regresses.
      const identityPassports = await this.db
        .select(identityRecordSafeColumns)
        .from(schema.identityRecords)
        .where(
          and(
            eq(schema.identityRecords.ownerUserId, trip.ownerUserId),
            eq(schema.identityRecords.recordType, "passport"),
            ne(schema.identityRecords.status, "renewed"),
            isNull(schema.identityRecords.deletedAt),
            isNotNull(schema.identityRecords.expirationDateSort),
          ),
        );
      const passports =
        identityPassports.length > 0
          ? identityPassports.map((r) => ({ id: r.id, title: r.label, expiresAtSort: r.expirationDateSort, linkedResourceType: "identity_record" as const }))
          : (
              await this.db
                .select()
                .from(schema.documents)
                .where(and(eq(schema.documents.ownerUserId, trip.ownerUserId), eq(schema.documents.documentKind, "passport"), isNull(schema.documents.deletedAt), isNotNull(schema.documents.expiresAtSort)))
            ).map((d) => ({ id: d.id, title: d.title, expiresAtSort: d.expiresAtSort, linkedResourceType: "document" as const }));
      for (const doc of passports) {
        const expiresSort = doc.expiresAtSort!;
        let reasonText: string | null = null;
        if (expiresSort.getTime() <= tripEnd.getTime()) {
          reasonText = `Your passport (${doc.title}) expires before your trip to ${trip.destinationLabel ?? "your destination"} ends — verify entry requirements for your destination.`;
        } else if (expiresSort.getTime() - tripEnd.getTime() < SIX_MONTHS_MS) {
          reasonText = `Your passport (${doc.title}) expires soon after your trip to ${trip.destinationLabel ?? "your destination"} — many destinations expect passport validity well beyond your travel dates; verify entry requirements for your destination.`;
        }
        if (!reasonText) continue;
        await this.fileIfNew({
          ownerUserId: trip.ownerUserId,
          householdId: trip.householdId,
          reasonCode: "travel_document_expiring",
          reasonText,
          urgency: "important",
          dueAt: trip.startDate,
          dueAtSort: trip.startDateSort!,
          moneyAtStakeMinorUnits: null,
          moneyAtStakeCurrency: null,
          confidenceBand: "verified",
          linkedResourceType: doc.linkedResourceType,
          linkedResourceId: doc.id,
          primaryActions: ["review_document", "view_trip"],
        });
      }
    }

    // §27 "Health Logistics" (HLTH-003 "medication refill reminder") — the human/health side of the shared
    // `refillReminders` table (`petProfileId IS NULL`; see that table's own schema doc comment). Deliberately
    // never surfaces a dose/frequency in the reasonText — only the plain user-entered medication label and
    // pharmacy, same non-diagnostic discipline as everywhere else in this chapter. A reminder already marked
    // picked up is never re-surfaced (mirrors bills.paymentObservedTransactionId's "distinguish due from
    // already-handled" role above).
    const refillReminders = await this.db
      .select()
      .from(schema.refillReminders)
      .where(and(isNull(schema.refillReminders.petProfileId), isNull(schema.refillReminders.deletedAt), isNull(schema.refillReminders.pickedUpAt), inWindow(schema.refillReminders.nextRefillDateSort)));
    for (const reminder of refillReminders) {
      const days = daysUntil(reminder.nextRefillDateSort!, now);
      const pharmacy = reminder.pharmacy ? ` at ${reminder.pharmacy}` : "";
      await this.fileIfNew({
        ownerUserId: reminder.ownerUserId,
        householdId: reminder.householdId,
        reasonCode: "refill_due",
        reasonText: `${reminder.medicationName} refill${pharmacy} is due in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: reminder.nextRefillDate,
        dueAtSort: reminder.nextRefillDateSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "refill_reminder",
        linkedResourceId: reminder.id,
        primaryActions: ["mark_picked_up"],
      });
    }

    // PET-003 — the pet side of the same shared `refillReminders` table (`petProfileId IS NOT NULL`),
    // mirroring the Health Logistics scan immediately above field-for-field (same non-diagnostic discipline:
    // plain medication name + pharmacy only, no dose/frequency ever surfaced).
    const petRefillReminders = await this.db
      .select()
      .from(schema.refillReminders)
      .where(and(isNotNull(schema.refillReminders.petProfileId), isNull(schema.refillReminders.deletedAt), isNull(schema.refillReminders.pickedUpAt), inWindow(schema.refillReminders.nextRefillDateSort)));
    for (const reminder of petRefillReminders) {
      const days = daysUntil(reminder.nextRefillDateSort!, now);
      const pharmacy = reminder.pharmacy ? ` at ${reminder.pharmacy}` : "";
      await this.fileIfNew({
        ownerUserId: reminder.ownerUserId,
        householdId: reminder.householdId,
        reasonCode: "pet_refill_due",
        reasonText: `${reminder.medicationName} refill${pharmacy} is due in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: reminder.nextRefillDate,
        dueAtSort: reminder.nextRefillDateSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "refill_reminder",
        linkedResourceId: reminder.id,
        primaryActions: ["mark_picked_up"],
      });
    }

    // PET-004 "Deadline must be sourced/user-confirmed" — only ever scans CONFIRMED vaccination/license
    // rows (source: "user_confirmed", set either by manual entry or by InboxService.confirm promoting an
    // evidence-sourced candidate — see petVaccinations' own schema doc comment). An "evidence_sourced"
    // candidate awaiting confirmation is deliberately never surfaced here — that would be exactly the
    // "filed as a scannable deadline before confirmation" spec forbids.
    const petVaccinations = await this.db
      .select()
      .from(schema.petVaccinations)
      .where(and(eq(schema.petVaccinations.source, "user_confirmed"), inWindow(schema.petVaccinations.expirationDateSort)));
    for (const vaccination of petVaccinations) {
      const days = daysUntil(vaccination.expirationDateSort!, now);
      await this.fileIfNew({
        ownerUserId: vaccination.ownerUserId,
        householdId: vaccination.householdId,
        reasonCode: "pet_vaccination_expiring",
        reasonText: `${vaccination.label} expires in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: vaccination.expirationDate,
        dueAtSort: vaccination.expirationDateSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "pet_vaccination",
        linkedResourceId: vaccination.id,
        primaryActions: ["review"],
      });
    }

    // TRIP-002/TRIP-003 "Set check-in reminder" — the actual notification-producing counterpart to
    // `tripSegments.checkInReminderMinutesBefore` (see TripsService.setSegmentCheckInReminder); before
    // this, setting the reminder had nowhere to actually fire from. Mirrors the CAL-002 event_reminder
    // scan above almost exactly (same lead-time-in-application-code, same "not yet time to remind, a
    // later tick will pick it up" early-continue), restricted to flight/lodging (the only kinds a
    // check-in reminder is meaningful for — see that column's own doc comment) and excluding a segment
    // whose reservation was itself cancelled. `trip_segments` has no `householdId` column of its own
    // (denormalized only on `trips` — see that table's schema doc comment), so this joins to the parent
    // trip for it, same as the rental-return scan just below.
    const checkInCandidates = await this.db
      .select({ segment: schema.tripSegments, trip: schema.trips })
      .from(schema.tripSegments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.tripSegments.tripId))
      .where(
        and(
          inArray(schema.tripSegments.kind, ["flight", "lodging"]),
          ne(schema.tripSegments.status, "cancelled"),
          isNotNull(schema.tripSegments.checkInReminderMinutesBefore),
          isNotNull(schema.tripSegments.startAtSort),
          gte(schema.tripSegments.startAtSort, now),
          lte(schema.tripSegments.startAtSort, lookahead),
        ),
      );
    for (const row of checkInCandidates) {
      const segment = row.segment;
      const leadMinutes = segment.checkInReminderMinutesBefore!;
      const remindAt = new Date(segment.startAtSort!.getTime() - leadMinutes * 60_000);
      if (remindAt > now) continue; // not yet time to remind — a later tick will pick it up
      const kindLabel = segment.kind === "flight" ? "Flight" : "Lodging";
      await this.fileIfNew({
        ownerUserId: segment.ownerUserId,
        householdId: row.trip.householdId,
        reasonCode: "trip_check_in_reminder",
        reasonText: `${kindLabel} check-in for ${segment.providerName ?? "your reservation"} ${relativeTimeText(segment.startAtSort!, now)}${segment.locationLabel ? ` at ${segment.locationLabel}` : ""}.`,
        urgency: leadMinutes <= 180 ? "important" : "useful",
        dueAt: segment.startAt,
        dueAtSort: segment.startAtSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "trip_segment",
        linkedResourceId: segment.id,
        primaryActions: ["view_trip"],
      });
    }

    // TRIP-004 "Rental-return time/location alert" — confirmed gap during this audit: nothing previously
    // scanned `trip_segments` for a rental/ground-transport return deadline at all. No new column needed
    // for the deadline itself — a rental segment's own `endAt`/`endAtSort` (common to every segment kind;
    // see tripSegments' own schema doc comment) already IS the return/dropoff time. The return location, if
    // one was extracted, lives in `detailsJson.dropoffLocation` (kind-specific — see extractTripSegment);
    // falls back to the segment's general `locationLabel` when that's null. A segment whose reservation was
    // itself cancelled is excluded — nothing to return.
    const rentalReturnCandidates = await this.db
      .select({ segment: schema.tripSegments, trip: schema.trips })
      .from(schema.tripSegments)
      .innerJoin(schema.trips, eq(schema.trips.id, schema.tripSegments.tripId))
      .where(and(eq(schema.tripSegments.kind, "rental"), ne(schema.tripSegments.status, "cancelled"), inWindow(schema.tripSegments.endAtSort)));
    for (const row of rentalReturnCandidates) {
      const segment = row.segment;
      const details = segment.detailsJson as { dropoffLocation?: string | null };
      const location = details.dropoffLocation ?? segment.locationLabel;
      const minutesUntil = (segment.endAtSort!.getTime() - now.getTime()) / 60_000;
      const urgency = minutesUntil <= 180 ? "critical" : minutesUntil <= 1440 ? "important" : "useful";
      await this.fileIfNew({
        ownerUserId: segment.ownerUserId,
        householdId: row.trip.householdId,
        reasonCode: "rental_return_due",
        reasonText: `Return your ${segment.providerName ?? "rental"}${location ? ` to ${location}` : ""} ${relativeTimeText(segment.endAtSort!, now)}.`,
        urgency,
        dueAt: segment.endAt,
        dueAtSort: segment.endAtSort!,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "trip_segment",
        linkedResourceId: segment.id,
        primaryActions: ["view_trip"],
      });
    }

    // "Identity & Legal Continuity" (ID-001..005) "creates expiration obligations" using each record's own
    // user-configurable `reminderLeadDays` (spec: "user-configurable lead time") instead of this scanner's
    // fixed 14-day LOOKAHEAD_MS window — a sensible passport/license lead time (often months) is far longer
    // than a bill's few days, so a per-row dynamic window is computed in application code here rather than
    // via `inWindow`'s fixed-interval SQL helper. This table is small per user, so an "active, has an
    // expiration date" fetch with no upper time bound, filtered in memory, is simpler and cheap — the same
    // "small table, filter in application code" tradeoff `documents.linkedEntityIds` scans elsewhere in this
    // service already make.
    const activeIdentityRecords = await this.db
      .select(identityRecordSafeColumns)
      .from(schema.identityRecords)
      .where(and(eq(schema.identityRecords.status, "active"), isNotNull(schema.identityRecords.expirationDateSort), isNull(schema.identityRecords.deletedAt)));
    for (const record of activeIdentityRecords) {
      const expiresSort = record.expirationDateSort!;
      const msUntil = expiresSort.getTime() - now.getTime();
      const leadMs = record.reminderLeadDays * 86_400_000;
      const typeLabel = IDENTITY_RECORD_TYPE_LABELS[record.recordType as IdentityRecordType] ?? "identity record";
      if (msUntil <= 0) {
        // Already past expiration — flip status to "expired" (only from "active"; never auto-overwrites a
        // "renewed" row, which this query already excludes). Status only ever moves to "renewed" via the
        // explicit `IdentityRecordsService.renewRecord` user action, never automatically here.
        await this.db.update(schema.identityRecords).set({ status: "expired", updatedAt: new Date() }).where(and(eq(schema.identityRecords.id, record.id), eq(schema.identityRecords.status, "active")));
        await this.fileOrEscalate(
          {
            ownerUserId: record.ownerUserId,
            householdId: record.householdId,
            reasonCode: "identity_record_expired",
            reasonText: `Your ${typeLabel} (${record.label}) has expired.`,
            urgency: "critical",
            dueAt: record.expirationDate,
            dueAtSort: expiresSort,
            moneyAtStakeMinorUnits: null,
            moneyAtStakeCurrency: null,
            confidenceBand: "verified",
            linkedResourceType: "identity_record",
            linkedResourceId: record.id,
            primaryActions: ["renew_record", "review_record"],
          },
          ["identity_record_expiring"],
        );
      } else if (msUntil <= leadMs) {
        const days = daysUntil(expiresSort, now);
        await this.fileIfNew({
          ownerUserId: record.ownerUserId,
          householdId: record.householdId,
          reasonCode: "identity_record_expiring",
          reasonText: `Your ${typeLabel} (${record.label}) expires in ${days} day${days === 1 ? "" : "s"}.`,
          urgency: urgencyFor(days),
          dueAt: record.expirationDate,
          dueAtSort: expiresSort,
          moneyAtStakeMinorUnits: null,
          moneyAtStakeCurrency: null,
          confidenceBand: "verified",
          linkedResourceType: "identity_record",
          linkedResourceId: record.id,
          primaryActions: ["renew_record", "review_record"],
        });
      }
    }

    await this.filePersonImportantDateReminders(now);
    await this.scanMaintenanceRules(now, lookahead);
    await this.scanRegistrationRecords(now);
  }

  /**
   * HOMEOS-004/VEH-003 "Maintenance engine"/"Maintenance schedule" — the attention-queue counterpart to
   * `maintenanceRules` (see that table's own schema doc comment for the calendar/mileage/whichever-first
   * design). Small-table-scan-then-join-in-memory, same tradeoff `filePersonImportantDateReminders` above
   * makes: this app's per-user rule count is small, and the alternative (a SQL join across
   * vehicles/home-assets/properties/odometer-observations with per-row interval math) would be far harder
   * to read for no real performance win at this scale.
   *
   * A rule's calendar side reuses the same 14-day `lookahead` window every other calendar scan in this
   * method uses; its mileage side has no calendar-date concept at all, so "approaching" is instead defined
   * as being within `MILEAGE_APPROACH_BUFFER` miles of the computed due mileage — mirroring the openRecalls
   * scan's identical "no future due date, file by current state instead" shape (`dueAtSort: now`).
   * `calendar_or_mileage` rules check both sides independently; `fileIfNew`'s own dedup (one row per
   * `linkedResourceType`+`linkedResourceId`) means a rule already filed by whichever side fired first simply
   * no-ops on the second check within the same pass, so this never double-files one rule.
   */
  private async scanMaintenanceRules(now: Date, lookahead: Date): Promise<void> {
    const rules = await this.db.select().from(schema.maintenanceRules).where(isNull(schema.maintenanceRules.deletedAt));
    if (rules.length === 0) return;

    const vehicleIds = [...new Set(rules.filter((r) => r.vehicleProfileId).map((r) => r.vehicleProfileId!))];
    const vehicles = vehicleIds.length > 0 ? await this.db.select().from(schema.vehicleProfiles).where(inArray(schema.vehicleProfiles.id, vehicleIds)) : [];
    const vehiclesById = new Map(vehicles.map((v) => [v.id, v] as const));

    const homeAssetIds = [...new Set(rules.filter((r) => r.homeAssetId).map((r) => r.homeAssetId!))];
    const homeAssetRows = homeAssetIds.length > 0 ? await this.db.select().from(schema.homeAssets).where(inArray(schema.homeAssets.id, homeAssetIds)) : [];
    const homeAssetsById = new Map(homeAssetRows.map((a) => [a.id, a] as const));
    const propertyIds = [...new Set(homeAssetRows.map((a) => a.propertyProfileId))];
    const properties = propertyIds.length > 0 ? await this.db.select().from(schema.propertyProfiles).where(inArray(schema.propertyProfiles.id, propertyIds)) : [];
    const propertiesById = new Map(properties.map((p) => [p.id, p] as const));

    // Current + earliest odometer readings per vehicle — same "highest reading wins" / "earliest by date is
    // the fallback baseline" reasoning AssetsService.latestOdometerMileage/earliestOdometerMileage document,
    // just computed in bulk here rather than per-vehicle (this scan already fetched every rule's vehicle
    // ids up front for the same reason).
    const currentMileageByVehicle = new Map<string, number>();
    const earliestMileageByVehicle = new Map<string, { mileage: number; observedAtSort: Date }>();
    if (vehicleIds.length > 0) {
      const observations = await this.db
        .select({ vehicleProfileId: schema.odometerObservations.vehicleProfileId, mileage: schema.odometerObservations.mileage, observedAtSort: schema.odometerObservations.observedAtSort })
        .from(schema.odometerObservations)
        .where(inArray(schema.odometerObservations.vehicleProfileId, vehicleIds));
      for (const obs of observations) {
        const highest = currentMileageByVehicle.get(obs.vehicleProfileId) ?? -1;
        if (obs.mileage > highest) currentMileageByVehicle.set(obs.vehicleProfileId, obs.mileage);
        const earliest = earliestMileageByVehicle.get(obs.vehicleProfileId);
        if (obs.observedAtSort && (!earliest || obs.observedAtSort < earliest.observedAtSort)) {
          earliestMileageByVehicle.set(obs.vehicleProfileId, { mileage: obs.mileage, observedAtSort: obs.observedAtSort });
        }
      }
    }

    const MILEAGE_APPROACH_BUFFER = 500;

    for (const rule of rules) {
      const guidance = rule.source === "seeded_generic_guidance" && rule.confidenceNote ? ` (${rule.confidenceNote})` : "";
      const confidenceBand = rule.source === "seeded_generic_guidance" ? "approximate" : "verified";
      let ownerUserId: string | null = null;
      let householdId: string | null = null;
      let subjectLabel: string;
      let currentMileage: number | null = null;
      let earliestMileage: number | null = null;
      let primaryActions: string[];

      if (rule.vehicleProfileId) {
        const vehicle = vehiclesById.get(rule.vehicleProfileId);
        if (!vehicle || vehicle.deletedAt) continue;
        ownerUserId = vehicle.ownerUserId;
        householdId = vehicle.householdId;
        subjectLabel = vehicle.label;
        currentMileage = currentMileageByVehicle.get(rule.vehicleProfileId) ?? null;
        earliestMileage = earliestMileageByVehicle.get(rule.vehicleProfileId)?.mileage ?? null;
        primaryActions = ["mark_maintenance_done", "view_vehicle"];
      } else if (rule.homeAssetId) {
        const asset = homeAssetsById.get(rule.homeAssetId);
        if (!asset || asset.deletedAt) continue;
        const property = propertiesById.get(asset.propertyProfileId);
        ownerUserId = asset.ownerUserId;
        householdId = property?.householdId ?? null;
        subjectLabel = asset.label;
        primaryActions = ["mark_maintenance_done", "view_property"];
      } else {
        continue; // orphaned rule — neither parent set; shouldn't happen given DTO-level validation, but fail closed
      }

      if (rule.intervalType === "calendar" || rule.intervalType === "calendar_or_mileage") {
        const anchor = rule.lastPerformedDateSort ?? rule.createdAt;
        const dueDate = new Date(anchor.getTime() + (rule.intervalDays ?? 0) * 86_400_000);
        if (rule.intervalDays && dueDate <= lookahead) {
          const overdue = dueDate < now;
          // `daysUntil` clamps negative differences to 0 (it's built for "how many days until a FUTURE
          // date," used everywhere else in this file) — wrong for "how many days has this ALREADY BEEN
          // overdue," which needs its own positive count, same as the bill_overdue scan's own `daysLate`.
          const days = overdue ? Math.max(1, Math.ceil((now.getTime() - dueDate.getTime()) / 86_400_000)) : daysUntil(dueDate, now);
          await this.fileIfNew({
            ownerUserId,
            householdId,
            reasonCode: "maintenance_due",
            reasonText: overdue
              ? `${rule.label} for ${subjectLabel} was due ${days} day${days === 1 ? "" : "s"} ago${guidance}.`
              : `${rule.label} for ${subjectLabel} is due in ${days} day${days === 1 ? "" : "s"}${guidance}.`,
            urgency: overdue ? "critical" : urgencyFor(days),
            dueAt: null,
            dueAtSort: dueDate,
            moneyAtStakeMinorUnits: null,
            moneyAtStakeCurrency: null,
            confidenceBand,
            linkedResourceType: "maintenance_rule",
            linkedResourceId: rule.id,
            primaryActions,
          });
        }
      }

      if ((rule.intervalType === "mileage" || rule.intervalType === "calendar_or_mileage") && rule.intervalMiles && currentMileage != null) {
        const baseline = rule.baselineMileage ?? earliestMileage ?? 0;
        const dueMileage = baseline + rule.intervalMiles;
        const remaining = dueMileage - currentMileage;
        if (remaining <= MILEAGE_APPROACH_BUFFER) {
          const overdue = remaining < 0;
          await this.fileIfNew({
            ownerUserId,
            householdId,
            reasonCode: "maintenance_due",
            reasonText: overdue
              ? `${rule.label} for ${subjectLabel} is overdue by about ${Math.abs(remaining).toLocaleString()} mi${guidance}.`
              : `${rule.label} for ${subjectLabel} is due in about ${remaining.toLocaleString()} mi${guidance}.`,
            urgency: overdue ? "critical" : remaining <= 100 ? "important" : "useful",
            dueAt: null,
            dueAtSort: now, // no calendar date for a mileage-only due point — same "file by current state" shape as the openRecalls scan above
            moneyAtStakeMinorUnits: null,
            moneyAtStakeCurrency: null,
            confidenceBand,
            linkedResourceType: "maintenance_rule",
            linkedResourceId: rule.id,
            primaryActions,
          });
        }
      }
    }
  }

  /**
   * VEH-004 "Registration / inspection / emissions" — mirrors the identity-records expiration scan above
   * almost exactly (per-row `reminderLeadDays` rather than the fixed 14-day window, flips to "expired" only
   * from "active," never auto-advances the due date itself — only the user's own
   * `AssetsService.renewRegistrationRecord` action does that).
   */
  private async scanRegistrationRecords(now: Date): Promise<void> {
    const records = await this.db
      .select()
      .from(schema.registrationRecords)
      .where(and(eq(schema.registrationRecords.status, "active"), isNotNull(schema.registrationRecords.renewalDueDateSort), isNull(schema.registrationRecords.deletedAt)));
    if (records.length === 0) return;

    const vehicleIds = [...new Set(records.map((r) => r.vehicleProfileId))];
    const vehicles = await this.db.select().from(schema.vehicleProfiles).where(inArray(schema.vehicleProfiles.id, vehicleIds));
    const vehiclesById = new Map(vehicles.map((v) => [v.id, v] as const));
    const RECORD_TYPE_LABEL: Record<string, string> = { registration: "registration", inspection: "inspection", emissions: "emissions test", other: "renewal" };

    for (const record of records) {
      const vehicle = vehiclesById.get(record.vehicleProfileId);
      if (!vehicle || vehicle.deletedAt) continue;
      const dueSort = record.renewalDueDateSort!;
      const msUntil = dueSort.getTime() - now.getTime();
      const leadMs = record.reminderLeadDays * 86_400_000;
      const typeLabel = RECORD_TYPE_LABEL[record.recordType] ?? "renewal";
      const jurisdiction = record.jurisdiction ? ` (${record.jurisdiction})` : "";
      if (msUntil <= 0) {
        await this.db
          .update(schema.registrationRecords)
          .set({ status: "expired", updatedAt: new Date() })
          .where(and(eq(schema.registrationRecords.id, record.id), eq(schema.registrationRecords.status, "active")));
        await this.fileOrEscalate(
          {
            ownerUserId: record.ownerUserId,
            householdId: vehicle.householdId,
            reasonCode: "registration_expired",
            reasonText: `${vehicle.label}'s ${typeLabel}${jurisdiction} has expired.`,
            urgency: "critical",
            dueAt: record.renewalDueDate,
            dueAtSort: dueSort,
            moneyAtStakeMinorUnits: null,
            moneyAtStakeCurrency: null,
            confidenceBand: "verified",
            linkedResourceType: "registration_record",
            linkedResourceId: record.id,
            primaryActions: ["mark_renewed", "view_vehicle"],
          },
          ["registration_expiring"],
        );
      } else if (msUntil <= leadMs) {
        const days = daysUntil(dueSort, now);
        await this.fileIfNew({
          ownerUserId: record.ownerUserId,
          householdId: vehicle.householdId,
          reasonCode: "registration_expiring",
          reasonText: `${vehicle.label}'s ${typeLabel}${jurisdiction} renews in ${days} day${days === 1 ? "" : "s"}.`,
          urgency: urgencyFor(days),
          dueAt: record.renewalDueDate,
          dueAtSort: dueSort,
          moneyAtStakeMinorUnits: null,
          moneyAtStakeCurrency: null,
          confidenceBand: "verified",
          linkedResourceType: "registration_record",
          linkedResourceId: record.id,
          primaryActions: ["mark_renewed", "view_vehicle"],
        });
      }
    }
  }

  /**
   * PEO-005 "Important dates ... can generate reminders" — mirrors ResurfacingService.evaluateBirthdayRule's
   * yearly-recurrence math (next occurrence of month/day at-or-after today) exactly, but files straight into
   * `attention_items` (the "Needs You" queue) via `insertAttentionItem` rather than through
   * `resurfacing_rules`/saved-memory resurfacing — a person's important date is a plain reminder, not a
   * saved-item resurfacing trigger. Deliberately bypasses `fileIfNew`'s permanent (linkedResourceType,
   * linkedResourceId) dedup for the same reason ResurfacingService's own doc comment gives: that dedup
   * would block a YEARLY reminder from ever firing again after its first year. The recurrence guard instead
   * lives on `personImportantDates.lastRemindedAt`, checked before this ever inserts — by the time
   * `insertAttentionItem` is reached, this occurrence hasn't been filed yet. Relies on this scan running at
   * concurrency 1 (see ResurfacingService's identical reliance) so two ticks can't race between the
   * gap-check and the insert.
   *
   * `isSensitive` dates never widen visibility beyond their owner: `householdId` is always null on the
   * filed item regardless of the parent person's own `visibility`, since `attention_items` has no
   * household-shared-reminder concept today and a household member's own private provider's birthday must
   * never leak into a shared queue.
   */
  private async filePersonImportantDateReminders(now: Date): Promise<void> {
    const RECURRENCE_GAP_MS = 300 * 24 * 60 * 60 * 1000; // see ResurfacingService's identical constant/reasoning
    const candidates = await this.db.select().from(schema.personImportantDates).where(isNull(schema.personImportantDates.deletedAt));
    if (candidates.length === 0) return;

    const personIds = [...new Set(candidates.map((c) => c.personId))];
    const people = await this.db.select().from(schema.people).where(inArray(schema.people.id, personIds));
    const peopleById = new Map(people.map((p) => [p.id, p] as const));

    for (const row of candidates) {
      if (row.lastRemindedAt && now.getTime() - row.lastRemindedAt.getTime() < RECURRENCE_GAP_MS) continue;
      const person = peopleById.get(row.personId);
      if (!person || person.deletedAt || person.mergedIntoPersonId) continue;

      const base = temporalToSortDate(row.date);
      if (!base) continue;
      let next = new Date(Date.UTC(now.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
      if (next < now) next = new Date(Date.UTC(now.getUTCFullYear() + 1, base.getUTCMonth(), base.getUTCDate()));
      const remindAt = new Date(next.getTime() - row.reminderDaysBefore * 86_400_000);
      if (remindAt > now) continue; // not yet time — a later daily tick will catch it

      const days = daysUntil(next, now);
      await this.insertAttentionItem({
        ownerUserId: row.ownerUserId,
        householdId: null,
        reasonCode: "person_important_date",
        reasonText: `${person.displayName}'s ${row.label.toLowerCase()} is in ${days} day${days === 1 ? "" : "s"}.`,
        urgency: urgencyFor(days),
        dueAt: row.date,
        dueAtSort: next,
        moneyAtStakeMinorUnits: null,
        moneyAtStakeCurrency: null,
        confidenceBand: "verified",
        linkedResourceType: "person",
        linkedResourceId: person.id,
        primaryActions: ["view_person"],
      });
      await this.db.update(schema.personImportantDates).set({ lastRemindedAt: now }).where(eq(schema.personImportantDates.id, row.id));
    }
  }

  /**
   * FIN-004 "Surface possible duplicate or unexpectedly different charge" reuses this rather than
   * duplicating the dedup-by-(linkedResourceType, linkedResourceId) logic — made public (was private)
   * specifically so FinanceService.detectAnomalousTransactions can file duplicate/unusual-charge attention
   * items through the exact same path every other deadline scan in this file already uses, instead of a
   * second parallel "insert an attention item" code path with its own dedup bugs to find later.
   */
  async fileIfNew(item: ScannedAttentionItem): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.attentionItems.id })
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, item.linkedResourceType), eq(schema.attentionItems.linkedResourceId, item.linkedResourceId)))
      .limit(1);
    if (existing) return;
    await this.insertAttentionItem(item);
  }

  /**
   * Like fileIfNew, but when an existing *unresolved* item for this resource is still at an earlier
   * stage (its reasonCode is in `escalatesFrom` — e.g. "bill_due" about to become "bill_overdue"),
   * updates that row in place to the new reason/urgency/dueAt instead of either leaving it stuck with
   * stale wording or silently no-op'ing the way fileIfNew would (fileIfNew's "any existing row for this
   * resource" check would otherwise treat the earlier-stage item as already filed and drop the
   * escalation on the floor). An item the user already resolved/dismissed is left alone — same "don't
   * resurrect what the user handled" stance fileIfNew already has.
   */
  private async fileOrEscalate(item: ScannedAttentionItem, escalatesFrom: string[]): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.attentionItems.id, resolved: schema.attentionItems.resolved, reasonCode: schema.attentionItems.reasonCode })
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, item.linkedResourceType), eq(schema.attentionItems.linkedResourceId, item.linkedResourceId)))
      .limit(1);
    if (!existing) {
      await this.insertAttentionItem(item);
      return;
    }
    if (existing.resolved || !escalatesFrom.includes(existing.reasonCode)) return;
    await this.db
      .update(schema.attentionItems)
      .set({
        reasonCode: item.reasonCode,
        reasonText: item.reasonText,
        urgency: item.urgency,
        dueAt: item.dueAt,
        dueAtSort: item.dueAtSort,
        primaryActions: item.primaryActions,
        updatedAt: new Date(),
      })
      .where(eq(schema.attentionItems.id, existing.id));
    // §33.1 escalation ladder example verbatim: "A due obligation may escalate from digest to push as
    // deadline approaches if unresolved" — this in-place update branch is exactly that transition
    // (bill_due -> bill_overdue today), so it needs its own notify call since it never goes through
    // insertAttentionItem below.
    await this.notifyIfUrgent(item);
  }

  private async insertAttentionItem(item: ScannedAttentionItem): Promise<void> {
    const attentionItemId = generateId("attentionItem");
    await this.db.insert(schema.attentionItems).values({
      id: attentionItemId,
      ownerUserId: item.ownerUserId,
      householdId: item.householdId,
      reasonCode: item.reasonCode,
      reasonText: item.reasonText,
      urgency: item.urgency,
      dueAt: item.dueAt,
      dueAtSort: item.dueAtSort,
      moneyAtStakeMinorUnits: item.moneyAtStakeMinorUnits,
      moneyAtStakeCurrency: item.moneyAtStakeCurrency,
      confidenceBand: item.confidenceBand,
      linkedResourceType: item.linkedResourceType,
      linkedResourceId: item.linkedResourceId,
      primaryActions: item.primaryActions,
    });
    // §42.3 "Attention" family — AttentionCandidateCreated, the closest §42.3-named event to "an attention
    // item was filed" (the taxonomy has no literal AttentionItemFiled — see AttentionCandidateCreatedPayload's
    // own doc comment in packages/core/src/events/payloads.ts). This single insert point is reached by
    // every "new attention item" path in this file (`fileIfNew`, the initial-file branch of
    // `fileOrEscalate`, and the direct `scanAndFileDeadlines`/person-important-date call above), so
    // emitting here — rather than once per call site — covers all of them without duplication.
    await this.events?.emit("AttentionCandidateCreated.v1", {
      ownerUserId: item.ownerUserId,
      householdId: item.householdId,
      aggregateType: "attention_item",
      aggregateId: attentionItemId,
      sensitivity: "sensitive",
      payload: {
        attentionItemId,
        reasonCode: item.reasonCode,
        urgency: item.urgency,
        confidenceBand: item.confidenceBand,
        linkedResourceType: item.linkedResourceType,
        linkedResourceId: item.linkedResourceId,
        moneyAtStakeMinorUnits: item.moneyAtStakeMinorUnits,
        moneyAtStakeCurrency: item.moneyAtStakeCurrency,
        dueAtIso: item.dueAtSort ? item.dueAtSort.toISOString() : null,
      },
    });
    await this.notifyIfUrgent(item);
  }

  /**
   * §33.1 priority model — found live via a fresh audit: `scanAndFileDeadlines` already classifies every
   * attention item into the spec's own Critical/Important/Useful urgency tiers (see `urgencyFor` and the
   * per-scan literals above), and `NotificationDeliveryService` already has full Critical/Important
   * delivery logic (the opt-in quiet-hours override, push-channel handling) — but nothing anywhere ever
   * called it for these items. Every real call site of `createAndEnqueue` in the whole codebase hardcodes
   * `priority: "useful"` (task assignment, automation, daily/digest brief, new-inbox-item), so a
   * Critical-tier item (an overdue bill, a confirmed vehicle/home recall) or an Important-tier item (a
   * bill due soon, an appointment starting within the hour) previously reached the user ONLY by checking
   * Home or waiting for the next opt-in daily/weekly digest email — up to 24 hours later for something the
   * spec's own table calls "Immediate push" / "Push + Home ... respecting quiet-hour override". This
   * bridges that gap for the two tiers the spec actually wants pushed; Useful stays digest-only/optional
   * push as already built, matching "Home + digest; optional push" without adding an immediate-push path
   * nothing asked for.
   *
   * AI-002 "cannot be created by low-confidence generative inference alone" (Critical tier specifically) —
   * every Critical urgency this file computes already pairs with `confidenceBand: "verified"` (bill
   * overdue, confirmed recall), but this checks it explicitly rather than relying on that staying true as
   * new scans are added later.
   *
   * dedupeKey uses `reasonCode:linkedResourceId` — the same "<category>:<resource-id>" convention
   * `NotificationDeliveryService.categoryOf` already documents — so a user can mute e.g. "vehicle_recall"
   * without muting "bill_overdue", and re-running this scan (fileIfNew's own existing-row check) never
   * double-fires for the same resource at the same reasonCode.
   */
  private async notifyIfUrgent(item: ScannedAttentionItem): Promise<void> {
    if (item.urgency !== "critical" && item.urgency !== "important") return;
    if (item.urgency === "critical" && item.confidenceBand !== "verified" && item.confidenceBand !== "high") return;
    await this.notifications.createAndEnqueue({
      ownerUserId: item.ownerUserId,
      dedupeKey: `${item.reasonCode}:${item.linkedResourceId}`,
      priority: item.urgency,
      channel: "push",
      title: item.urgency === "critical" ? "Needs you now" : "Needs your attention",
      body: item.reasonText,
    });
  }

  private async assertOwned(id: string, userId: string) {
    const [item] = await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "ATTENTION_ITEM_NOT_FOUND", message: "Not found." });
    // 403, not 400 — matches ScheduleService/DataExportService's own NOT_OWNER convention. This used to be
    // a BadRequestException (HTTP 400) here and in InboxService's identical check, while the rest of this
    // module family (schedule, data-export) used ForbiddenException (403) for the exact same "exists but
    // isn't yours" situation with the same error code — a client written against one convention would
    // mishandle the other (e.g. treat 403 as "retry differently than a validation error").
    if (item.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your item." });
    return item;
  }
}
