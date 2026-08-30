import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, lt } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

// Backend-robustness audit finding — the one list endpoint the earlier pagination pass missed. Same
// cursor-pagination shape as Documents/Inbox's own `list()` (`before` cursor, fetch PAGE_SIZE+1,
// slice+nextCursor) for consistency across the app's list endpoints.
const NOTIFICATIONS_PAGE_SIZE = 30;

@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(userId: string, before?: string | null): Promise<{ items: (typeof schema.notifications.$inferSelect)[]; nextCursor: string | null }> {
    const beforeDate = before ? new Date(before) : null;
    const ownerCondition = eq(schema.notifications.ownerUserId, userId);
    const rows = await this.db
      .select()
      .from(schema.notifications)
      .where(beforeDate ? and(ownerCondition, lt(schema.notifications.scheduledFor, beforeDate)) : ownerCondition)
      .orderBy(desc(schema.notifications.scheduledFor))
      .limit(NOTIFICATIONS_PAGE_SIZE + 1);
    const hasMore = rows.length > NOTIFICATIONS_PAGE_SIZE;
    const items = hasMore ? rows.slice(0, NOTIFICATIONS_PAGE_SIZE) : rows;
    const last = items[items.length - 1];
    return { items, nextCursor: hasMore && last ? last.scheduledFor.toISOString() : null };
  }

  /** OS-level notification action buttons and plain taps both funnel through this — the acknowledgment-
   * tracking substrate a later escalation ladder/fatigue-feedback mechanism builds on. Overwrites cleanly
   * on repeat calls (e.g. a tap after an earlier action button), so it's safe to call more than once. */
  async acknowledge(notificationId: string, userId: string, action: "opened" | "resolved" | "dismissed" | "snoozed"): Promise<void> {
    const [notification] = await this.db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.id, notificationId), eq(schema.notifications.ownerUserId, userId)))
      .limit(1);
    if (!notification) throw new NotFoundException({ code: "NOTIFICATION_NOT_FOUND", message: "Not found." });

    await this.db
      .update(schema.notifications)
      .set({ acknowledgedAt: new Date(), actionTaken: action })
      .where(eq(schema.notifications.id, notificationId));
  }

  async getPreferences(userId: string) {
    const [prefs] = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, userId))
      .limit(1);
    return (
      prefs ?? {
        userId,
        intensity: "balanced",
        quietHoursStart: null,
        quietHoursEnd: null,
        categoryOverrides: {},
        dailyBriefEnabled: true,
        weeklyBriefEnabled: true,
      }
    );
  }

  async updatePreferences(
    userId: string,
    patch: Partial<{
      intensity: string;
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
      dailyBriefEnabled: boolean;
      weeklyBriefEnabled: boolean;
      /** Per-category mute — `{ [category]: "off" }` to mute, any other/no entry means default delivery.
       * Keys match what NotificationDeliveryService.createAndEnqueue's callers pass as `category`
       * (domain names like "bill"/"purchase", or "daily_brief"/"weekly_brief" for digests). */
      categoryOverrides: Record<string, string>;
    }>,
  ) {
    const existing = await this.getPreferences(userId);
    const merged = { ...existing, ...patch, userId };
    await this.db
      .insert(schema.notificationPreferences)
      .values(merged)
      .onConflictDoUpdate({ target: schema.notificationPreferences.userId, set: merged });
    return merged;
  }
}
