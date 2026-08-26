import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, gte, lte } from "drizzle-orm";
import { schema } from "@veynlo/db";
import type { Database } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { NotificationDeliveryService } from "./notification-delivery.service";

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
    private readonly delivery: NotificationDeliveryService,
  ) {}

  async dispatchDailyBrief(): Promise<void> {
    const eligibleUsers = await this.db
      .select({ userId: schema.notificationPreferences.userId })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.dailyBriefEnabled, true));

    const today = new Date();
    const todayKey = today.toISOString().slice(0, 10);

    for (const { userId } of eligibleUsers) {
      const items = await this.db
        .select()
        .from(schema.attentionItems)
        .where(and(eq(schema.attentionItems.ownerUserId, userId), eq(schema.attentionItems.resolved, false)));

      if (items.length === 0) continue; // no dead "nothing to report" digest — only send when there's something real to say

      const lines = items
        .slice(0, 10)
        .map((i) => `• ${i.reasonText}`)
        .join("\n");
      const result = await this.delivery.createAndEnqueue({
        ownerUserId: userId,
        dedupeKey: `daily-brief:${todayKey}`,
        priority: "useful",
        title: `Your daily brief — ${items.length} thing${items.length === 1 ? "" : "s"} to know`,
        body: `Here's what needs your attention today:\n\n${lines}`,
      });
      if ("notificationId" in result) this.logger.log(`Queued daily brief for ${userId}`);
    }
  }

  async dispatchWeeklyBrief(): Promise<void> {
    const eligibleUsers = await this.db
      .select({ userId: schema.notificationPreferences.userId })
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.weeklyBriefEnabled, true));

    const now = new Date();
    const weekFromNow = new Date(now.getTime() + 7 * 86_400_000);
    const weekKey = `${now.getFullYear()}-W${Math.ceil((now.getDate() + now.getDay()) / 7)}`;

    for (const { userId } of eligibleUsers) {
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

      const lines = [
        ...upcomingEvents.map((e) => `• ${e.title}`),
        ...upcomingBills.map((b) => `• Bill due: ${b.billerLabel}`),
      ].join("\n");

      await this.delivery.createAndEnqueue({
        ownerUserId: userId,
        dedupeKey: `weekly-brief:${weekKey}`,
        priority: "useful",
        title: "Your week ahead",
        body: `Coming up in the next 7 days:\n\n${lines}`,
      });
    }
  }
}
