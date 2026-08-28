import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, gte, isNotNull, lte } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

const LOOKAHEAD_MS = 14 * 24 * 60 * 60 * 1000;

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

  /** HOME-001/004 — the ranked "Needs You" queue plus the caught-up/degraded state computation. */
  async home(userId: string) {
    const items = await this.db
      .select()
      .from(schema.attentionItems)
      .where(and(eq(schema.attentionItems.ownerUserId, userId), eq(schema.attentionItems.resolved, false)))
      .orderBy(asc(schema.attentionItems.dueAtSort));

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
}
