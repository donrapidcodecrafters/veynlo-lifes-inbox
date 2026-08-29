import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomBytes, createHash } from "node:crypto";
import { and, asc, eq, gte, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;
const SHARE_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * HOME-001's ranking model, scoped down from the spec's full list (urgency, severity, certainty, user
 * preference, consequence, money at risk, household dependencies, notification history, duplicate
 * suppression) to the three signals this codebase actually has real data for. Higher score = shown
 * first. Combines a coarse urgency-tier weight (dominant — a critical item should never sort below an
 * "important" one no matter its money value) with a continuous money-at-stake term (log-scaled so a
 * $50,000 item doesn't drown out every other critical item by two orders of magnitude) and a small
 * recency nudge so two same-tier/same-value items still break ties by which is due sooner.
 */
function scoreFor(item: { urgency: string; moneyAtStakeMinorUnits: number | null; dueAtSort: Date | null }, now: Date): number {
  const urgencyWeight = item.urgency === "critical" ? 1000 : item.urgency === "important" ? 500 : 100;
  const moneyWeight = item.moneyAtStakeMinorUnits ? Math.log10(Math.max(1, item.moneyAtStakeMinorUnits / 100) + 1) * 10 : 0;
  const daysUntilDue = item.dueAtSort ? Math.max(0, (item.dueAtSort.getTime() - now.getTime()) / 86_400_000) : LOOKAHEAD_MS / 86_400_000;
  const recencyWeight = Math.max(0, 14 - daysUntilDue);
  return urgencyWeight + moneyWeight + recencyWeight;
}

function daysUntil(target: Date, now: Date): number {
  return Math.max(0, Math.ceil((target.getTime() - now.getTime()) / 86_400_000));
}

function urgencyFor(days: number): "critical" | "important" | "useful" {
  if (days <= 3) return "critical";
  if (days <= 7) return "important";
  return "useful";
}

function money(minorUnits: number, currency: string): string {
  return `${(minorUnits / 100).toFixed(2)} ${currency}`;
}

@Injectable()
export class AttentionService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * HOME-001/004 — the weighted "Needs You" queue plus the caught-up/degraded state computation.
   * Includes items delegated TO this user (assignedToUserId) alongside their own, so assigning
   * something to a household member actually surfaces it in their queue, not just a database column.
   */
  async home(userId: string) {
    const now = new Date();
    await this.unsnoozeExpired(userId, now);

    const items = await this.db
      .select()
      .from(schema.attentionItems)
      .where(
        and(
          or(eq(schema.attentionItems.ownerUserId, userId), eq(schema.attentionItems.assignedToUserId, userId)),
          eq(schema.attentionItems.resolved, false),
          or(isNull(schema.attentionItems.snoozedUntil), lte(schema.attentionItems.snoozedUntil, now)),
        ),
      )
      .orderBy(asc(schema.attentionItems.dueAtSort));

    const ranked = [...items].sort((a, b) => scoreFor(b, now) - scoreFor(a, now));

    const connections = await this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, userId));
    const unhealthyConnections = connections.filter((c) => !["healthy", "initializing"].includes(c.health));

    return {
      items: ranked,
      caughtUp: ranked.length === 0,
      degraded: unhealthyConnections.length > 0,
      unhealthyConnections: unhealthyConnections.map((c) => ({ id: c.id, provider: c.provider, health: c.health })),
    };
  }

  /**
   * HOME-002, deliberately scoped down: the spec's "Today view" wants a full timeline-projection service
   * merging calendar events/tasks/deliveries/trip milestones from canonical objects with double-counting
   * prevention — none of that projection infra (or a `deliveries`/`trip_segments` domain distinct from
   * shipments/trips) exists yet. This instead merges the three domains that DO have a real "due today"
   * concept today (calendar events, tasks, bills) directly, sorted chronologically.
   */
  async today(userId: string) {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const inToday = (col: AnyPgColumn) => and(isNotNull(col), gte(col, startOfDay), lte(col, endOfDay))!;

    const [events, tasks, bills] = await Promise.all([
      this.db
        .select({ id: schema.calendarEvents.id, title: schema.calendarEvents.title, at: schema.calendarEvents.startSort })
        .from(schema.calendarEvents)
        .where(and(eq(schema.calendarEvents.ownerUserId, userId), inToday(schema.calendarEvents.startSort))),
      this.db
        .select({ id: schema.tasks.id, title: schema.tasks.title, at: schema.tasks.dueSort })
        .from(schema.tasks)
        .where(and(eq(schema.tasks.ownerUserId, userId), eq(schema.tasks.state, "open"), inToday(schema.tasks.dueSort))),
      this.db
        .select({ id: schema.bills.id, title: schema.bills.billerLabel, at: schema.bills.dueDateSort })
        .from(schema.bills)
        .where(and(eq(schema.bills.ownerUserId, userId), inToday(schema.bills.dueDateSort))),
    ]);

    const merged = [
      ...events.map((e) => ({ kind: "event" as const, id: e.id, title: e.title, at: e.at! })),
      ...tasks.map((t) => ({ kind: "task" as const, id: t.id, title: t.title, at: t.at! })),
      ...bills.map((b) => ({ kind: "bill" as const, id: b.id, title: `${b.title} due`, at: b.at! })),
    ].sort((a, b) => a.at.getTime() - b.at.getTime());

    return { items: merged };
  }

  async resolve(id: string, userId: string) {
    await this.assertAccess(id, userId);
    await this.db.update(schema.attentionItems).set({ resolved: true, updatedAt: new Date() }).where(eq(schema.attentionItems.id, id));
  }

  async dismiss(id: string, userId: string, reason: string) {
    await this.assertAccess(id, userId);
    await this.db
      .update(schema.attentionItems)
      .set({ resolved: true, dismissedReason: reason, updatedAt: new Date() })
      .where(eq(schema.attentionItems.id, id));
  }

  async snooze(id: string, userId: string, until: Date) {
    await this.assertAccess(id, userId);
    await this.db.update(schema.attentionItems).set({ snoozedUntil: until, updatedAt: new Date() }).where(eq(schema.attentionItems.id, id));
  }

  /**
   * HOME-001's "delegate" action — assigns an item to another member of the SAME household the item
   * already belongs to (never an arbitrary user id, and never a household-less item — there's no
   * membership list to validate against without one). `assigneeUserId: null` un-assigns. The assignee
   * doesn't need to be notified for this to be real: home() already includes assignedToUserId matches,
   * so the moment this commits, the item appears in the assignee's own "Needs You" queue.
   */
  async delegate(id: string, userId: string, assigneeUserId: string | null) {
    const item = await this.assertOwned(id, userId);
    if (assigneeUserId) {
      if (!item.householdId) {
        throw new BadRequestException({ code: "NO_HOUSEHOLD", message: "This item isn't part of a household, so it can't be delegated." });
      }
      const [membership] = await this.db
        .select({ id: schema.householdMemberships.id })
        .from(schema.householdMemberships)
        .where(
          and(
            eq(schema.householdMemberships.householdId, item.householdId),
            eq(schema.householdMemberships.userId, assigneeUserId),
            eq(schema.householdMemberships.status, "active"),
          ),
        )
        .limit(1);
      if (!membership) {
        throw new BadRequestException({ code: "NOT_HOUSEHOLD_MEMBER", message: "That person isn't an active member of this household." });
      }
    }
    await this.db.update(schema.attentionItems).set({ assignedToUserId: assigneeUserId, updatedAt: new Date() }).where(eq(schema.attentionItems.id, id));
  }

  /**
   * HOME-001's "share" action — generates a real, revocable, expiring link via the `share_links` table
   * and `resolveShareLinkAccess` (packages/authz), which already existed with zero real caller anywhere
   * in the app before this. No passcode support exposed here (the schema/authz layer already supports
   * one) — a defensible MVP cut given the link itself is a long random token, expires in 7 days, and is
   * always revocable. Returns the plaintext token exactly once — only its hash is ever stored.
   */
  async createShareLink(id: string, userId: string) {
    await this.assertOwned(id, userId);
    const token = randomBytes(24).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const shareLinkId = generateId("shareLink");
    await this.db.insert(schema.shareLinks).values({
      id: shareLinkId,
      resourceType: "attention_item",
      resourceId: id,
      tokenHash,
      createdByUserId: userId,
      expiresAt: new Date(Date.now() + SHARE_LINK_TTL_MS),
    });
    return { url: `${loadEnv().WEB_APP_URL}/shared/${token}` };
  }

  async revokeShareLinks(id: string, userId: string) {
    await this.assertOwned(id, userId);
    await this.db
      .update(schema.shareLinks)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.shareLinks.resourceType, "attention_item"), eq(schema.shareLinks.resourceId, id), isNull(schema.shareLinks.revokedAt)));
  }

  private async unsnoozeExpired(userId: string, now: Date): Promise<void> {
    await this.db
      .update(schema.attentionItems)
      .set({ snoozedUntil: null })
      .where(
        and(
          or(eq(schema.attentionItems.ownerUserId, userId), eq(schema.attentionItems.assignedToUserId, userId)),
          isNotNull(schema.attentionItems.snoozedUntil),
          lte(schema.attentionItems.snoozedUntil, now),
        ),
      );
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
   * resolved one doesn't have it silently reappear on the next tick. Does not (yet) auto-resolve an item
   * when its underlying deadline is handled outside the app (e.g. a bill paid by autopay) — bills have no
   * "paid" state to check today, so that would require guessing; the user's own resolve/dismiss stays the
   * only way to clear one. Does not surface already-overdue deadlines, for the same reason: without a
   * paid/handled signal, surfacing something that already passed risks being wrong as often as useful.
   */
  async scanAndFileDeadlines(): Promise<void> {
    const now = new Date();
    const lookahead = new Date(now.getTime() + LOOKAHEAD_MS);
    const inWindow = (col: AnyPgColumn) => and(isNotNull(col), gte(col, now), lte(col, lookahead))!;

    const bills = await this.db.select().from(schema.bills).where(inWindow(schema.bills.dueDateSort));
    for (const bill of bills) {
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
  }

  private async fileIfNew(item: {
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
  }): Promise<void> {
    const [existing] = await this.db
      .select({ id: schema.attentionItems.id })
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.linkedResourceType, item.linkedResourceType), eq(schema.attentionItems.linkedResourceId, item.linkedResourceId)))
      .limit(1);
    if (existing) return;

    await this.db.insert(schema.attentionItems).values({
      id: generateId("attentionItem"),
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
  }

  private async assertOwned(id: string, userId: string) {
    const [item] = await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "ATTENTION_ITEM_NOT_FOUND", message: "Not found." });
    if (item.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your item." });
    return item;
  }

  /** Owner OR the person it's currently delegated to — used for actions a delegate should be able to take on their own assigned work (resolve/dismiss/snooze), unlike delegate/share themselves, which stay owner-only. */
  private async assertAccess(id: string, userId: string) {
    const [item] = await this.db.select().from(schema.attentionItems).where(eq(schema.attentionItems.id, id)).limit(1);
    if (!item) throw new NotFoundException({ code: "ATTENTION_ITEM_NOT_FOUND", message: "Not found." });
    if (item.ownerUserId !== userId && item.assignedToUserId !== userId) {
      throw new BadRequestException({ code: "NOT_OWNER", message: "Not your item." });
    }
    return item;
  }
}
