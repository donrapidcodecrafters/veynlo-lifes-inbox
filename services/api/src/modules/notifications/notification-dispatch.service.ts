import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";
import { schema } from "@veynlo/db";
import type { Database } from "@veynlo/db";
import { formatMoney, MASKED_AMOUNT_PLACEHOLDER, redactDollarAmounts } from "@veynlo/core";
import { DATABASE } from "../../database/database.module";
import { NotificationDeliveryService } from "./notification-delivery.service";
import { PreferencesService } from "../preferences/preferences.service";

/** Matches the "Month D, YYYY" shape already used elsewhere in brief/notification copy (e.g. an
 * extracted bill's reasonText reads "due September 15, 2026") — kept consistent rather than introducing
 * a second date style just for the weekly brief's own bill line. */
function formatBriefDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

/** Bills are only sometimes fully known (amount/currency are nullable — an extracted bill can be filed
 * before every field is confident). Falls back to just the biller + due date rather than printing
 * "undefined" or a bare "$NaN" when the amount hasn't been captured. FIN-007 "hidden on ... notifications" —
 * `maskAmount` swaps the real figure for the shared placeholder when the recipient has financial privacy
 * mode on, same as every other masked surface in this codebase. */
function formatBriefBillLine(bill: typeof schema.bills.$inferSelect, maskAmount: boolean): string {
  const due = bill.dueDateSort ? ` — due ${formatBriefDate(bill.dueDateSort)}` : "";
  if (bill.amountDueMinorUnits == null || !bill.amountDueCurrency) {
    return `• Bill due: ${bill.billerLabel}${due}`;
  }
  const amount = maskAmount ? MASKED_AMOUNT_PLACEHOLDER : formatMoney({ minorUnits: bill.amountDueMinorUnits, currency: bill.amountDueCurrency });
  return `• Bill due: ${bill.billerLabel} — ${amount}${due}`;
}

/**
 * §NOT-005/006 — Daily/Weekly Brief. Composes one digest notification per
 * eligible user rather than a flood of individual pushes (§33 "attention is
 * scarce" / notification fatigue is an explicit product risk).
 */
@Injectable()
export class NotificationDispatchService {
  private readonly logger = new Logger(NotificationDispatchService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(NotificationDeliveryService) private readonly delivery: NotificationDeliveryService,
    @Inject(PreferencesService) private readonly preferences: PreferencesService,
  ) {}

  async dispatchDailyBrief(): Promise<void> {
    const eligibleUsers = await this.db
      .select({ userId: schema.notificationPreferences.userId, sensitivePreviewsEnabled: schema.notificationPreferences.sensitivePreviewsEnabled })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.dailyBriefEnabled, true));

    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);

    for (const { userId, sensitivePreviewsEnabled } of eligibleUsers) {
      const items = await this.db
        .select()
        .from(schema.attentionItems)
        .where(and(eq(schema.attentionItems.ownerUserId, userId), eq(schema.attentionItems.resolved, false)));

      if (items.length === 0) continue; // no dead "nothing to report" digest — only send when there's something real to say

      // FIN-007 "hidden on ... notifications" — an attention item's reasonText can embed a literal dollar
      // figure (e.g. FinanceService.detectAnomalousTransactions' "This $123.45 charge to..."); there's no
      // single Money value to swap out here, only prose, so redactDollarAmounts strips any dollar-shaped
      // substring rather than requiring every reasonText producer to know about masking.
      const maskAmounts = await this.preferences.isFinancialPrivacyModeEnabled(userId);

      // §23 "unless the user explicitly permits that preview level" — with previews off, the count is
      // still useful (it's what makes this worth opening) but the actual reasons/amounts/dates stay out
      // of the email body until the user opens the app.
      const body = sensitivePreviewsEnabled
        ? `Here's what needs your attention today:\n\n${items
            .slice(0, 10)
            .map((i) => `• ${maskAmounts ? redactDollarAmounts(i.reasonText) : i.reasonText}`)
            .join("\n")}`
        : `${items.length} item${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} your attention today. Open Veynlo to see the details.`;
      const result = await this.delivery.createAndEnqueue({
        ownerUserId: userId,
        dedupeKey: `daily-brief:${todayKey}`,
        priority: "useful",
        title: `Your daily brief — ${items.length} thing${items.length === 1 ? "" : "s"} to know`,
        body,
      });
      if ("notificationId" in result) this.logger.log(`Queued daily brief for ${userId}`);
    }
  }

  async dispatchWeeklyBrief(): Promise<void> {
    const eligibleUsers = await this.db
      .select({ userId: schema.notificationPreferences.userId, sensitivePreviewsEnabled: schema.notificationPreferences.sensitivePreviewsEnabled })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.weeklyBriefEnabled, true));

    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 86_400_000);
    const weekKey = `${now.getFullYear()}-W${Math.ceil((now.getDate() + now.getDay()) / 7)}`;

    for (const { userId, sensitivePreviewsEnabled } of eligibleUsers) {
      const upcomingEvents = await this.db
        .select()
        .from(schema.calendarEvents)
        .where(
          and(
            eq(schema.calendarEvents.ownerUserId, userId),
            gte(schema.calendarEvents.startSort, now),
            lte(schema.calendarEvents.startSort, weekFromNow),
          ),
        );
      const upcomingBills = await this.db
        .select()
        .from(schema.bills)
        .where(
          and(
            eq(schema.bills.ownerUserId, userId),
            gte(schema.bills.dueDateSort, now),
            lte(schema.bills.dueDateSort, weekFromNow),
          ),
        );

      if (upcomingEvents.length === 0 && upcomingBills.length === 0) continue;

      const maskAmounts = await this.preferences.isFinancialPrivacyModeEnabled(userId);

      const body = sensitivePreviewsEnabled
        ? `Coming up in the next 7 days:\n\n${[
            ...upcomingEvents.map((e) => `• ${e.title}`),
            ...upcomingBills.map((b) => formatBriefBillLine(b, maskAmounts)),
          ].join("\n")}`
        : `${upcomingEvents.length + upcomingBills.length} thing${upcomingEvents.length + upcomingBills.length === 1 ? "" : "s"} coming up in the next 7 days. Open Veynlo to see the details.`;

      await this.delivery.createAndEnqueue({
        ownerUserId: userId,
        dedupeKey: `weekly-brief:${weekKey}`,
        priority: "useful",
        title: "Your week ahead",
        body,
      });
    }
  }
}
