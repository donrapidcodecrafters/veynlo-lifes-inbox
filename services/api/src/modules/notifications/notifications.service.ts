import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { UpdateNotificationPreferencesDto } from "./dto";

@Injectable()
export class NotificationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  list(userId: string) {
    return this.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.ownerUserId, userId))
      .orderBy(desc(schema.notifications.scheduledFor));
  }

  /**
   * Records that the user opened a notification.
   *
   * Idempotent by construction — `isNull(openedAt)` in the predicate rather than a read-then-write, so
   * two taps racing each other (a cold-start handler and a foreground listener can both fire for one
   * notification) cannot overwrite the first time with the second. The first open is the fact worth
   * keeping; overwriting it would quietly turn "how long until they looked" into "when did they last look".
   *
   * Scoped to the owner in the same predicate for the same reason every other route here is: an id from a
   * push payload is caller-supplied input, and a notification id is guessable enough that this must not
   * be a bare update by id.
   */
  async markOpened(notificationId: string, userId: string) {
    const [updated] = await this.db
      .update(schema.notifications)
      .set({ openedAt: new Date() })
      .where(
        and(
          eq(schema.notifications.id, notificationId),
          eq(schema.notifications.ownerUserId, userId),
          isNull(schema.notifications.openedAt),
        ),
      )
      .returning({ id: schema.notifications.id, openedAt: schema.notifications.openedAt });

    // Nothing updated means either it was already open, it is not this user's, or it does not exist. All
    // three answer the same way: a notification tap must never show the user an error for something they
    // already did, and must not tell them whether an id they did not own exists.
    if (updated) return { id: updated.id, openedAt: updated.openedAt };
    const [existing] = await this.db
      .select({ id: schema.notifications.id, openedAt: schema.notifications.openedAt })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.id, notificationId), eq(schema.notifications.ownerUserId, userId)))
      .limit(1);
    return existing ? { id: existing.id, openedAt: existing.openedAt } : { id: notificationId, openedAt: null };
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
        criticalOverridesQuietHours: true,
        categoryOverrides: {},
        dailyBriefEnabled: true,
        weeklyBriefEnabled: true,
        sensitivePreviewsEnabled: true,
        monthlySpendCapMinorUnits: null,
      }
    );
  }

  async updatePreferences(userId: string, patch: UpdateNotificationPreferencesDto) {
    const existing = await this.getPreferences(userId);
    const merged = { ...existing, ...patch, userId };
    await this.db
      .insert(schema.notificationPreferences)
      .values(merged)
      .onConflictDoUpdate({ target: schema.notificationPreferences.userId, set: merged });
    return merged;
  }
}
