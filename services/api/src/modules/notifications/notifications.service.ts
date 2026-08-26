import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";

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
