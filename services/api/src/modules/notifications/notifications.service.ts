import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, gte, isNotNull, lt } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

// Backend-robustness audit finding — the one list endpoint the earlier pagination pass missed. Same
// cursor-pagination shape as Documents/Inbox's own `list()` (`before` cursor, fetch PAGE_SIZE+1,
// slice+nextCursor) for consistency across the app's list endpoints.
const NOTIFICATIONS_PAGE_SIZE = 30;

// Fatigue-feedback mechanism (§NOT-002 final part): engagement window, minimum sample size, and the
// "unwanted" threshold that triggers a mute suggestion.
const FATIGUE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const FATIGUE_MIN_SAMPLE = 5;
const FATIGUE_UNWANTED_RATE_THRESHOLD = 0.6;

export interface FatigueSuggestion {
  category: string;
  sentCount: number;
  unwantedCount: number;
  unwantedRate: number;
}

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
        privacyLevel: "full",
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
      /** Lock-screen privacy ladder: "full" | "hide_amounts" | "hide_titles" | "generic" — applied at
       * send time by NotificationDeliveryService.sendPush (see applyPrivacyLevel). */
      privacyLevel: string;
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

  /** Fatigue-feedback mechanism (§NOT-002 final part): surfaces categories the caller has mostly been
   * dismissing or ignoring lately, so the UI can offer a one-tap mute. "Unwanted" = actionTaken ===
   * "dismissed", or never acknowledged at all — both read as "this notification wasn't wanted." Requires
   * a minimum sample per category so one bad week of a rarely-sent category doesn't trigger a suggestion,
   * and skips categories already muted since suggesting to mute an already-muted category is pointless. */
  async fatigueSuggestions(userId: string): Promise<FatigueSuggestion[]> {
    const since = new Date(Date.now() - FATIGUE_WINDOW_MS);
    const rows = await this.db
      .select({ category: schema.notifications.category, actionTaken: schema.notifications.actionTaken, acknowledgedAt: schema.notifications.acknowledgedAt })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.ownerUserId, userId),
          isNotNull(schema.notifications.category),
          eq(schema.notifications.state, "sent"),
          gte(schema.notifications.sentAt, since),
        ),
      );

    const byCategory = new Map<string, { sentCount: number; unwantedCount: number }>();
    for (const row of rows) {
      const category = row.category!;
      const stats = byCategory.get(category) ?? { sentCount: 0, unwantedCount: 0 };
      stats.sentCount += 1;
      if (row.actionTaken === "dismissed" || row.acknowledgedAt === null) stats.unwantedCount += 1;
      byCategory.set(category, stats);
    }

    const prefs = await this.getPreferences(userId);
    const suggestions: FatigueSuggestion[] = [];
    for (const [category, stats] of byCategory) {
      if (stats.sentCount < FATIGUE_MIN_SAMPLE) continue;
      if (prefs.categoryOverrides?.[category] === "off") continue;
      const unwantedRate = stats.unwantedCount / stats.sentCount;
      if (unwantedRate < FATIGUE_UNWANTED_RATE_THRESHOLD) continue;
      suggestions.push({ category, sentCount: stats.sentCount, unwantedCount: stats.unwantedCount, unwantedRate });
    }

    return suggestions.sort((a, b) => b.unwantedRate - a.unwantedRate);
  }
}
