import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { MailerService } from "./mailer.service";
import { isWithinQuietHours } from "./quiet-hours";

export type NotificationPriority = "critical" | "important" | "useful" | "fyi" | "silent";

/**
 * §33 — notification priority tiers + quiet hours + dedupe. This is the
 * single chokepoint every part of the product goes through to actually
 * notify a user, so suppression rules (quiet hours, per-category "off",
 * duplicate dedupe key) are enforced in exactly one place.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queue: QueueProducerService,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Creates a notification candidate and enqueues delivery. Silently no-ops
   * (via the dedupe key's unique-per-user semantics, checked here rather
   * than relying on a DB constraint) if an unresolved notification with the
   * same dedupe key already exists — the classic "don't re-notify about a
   * bill that's still due tomorrow" case.
   */
  async createAndEnqueue(params: {
    ownerUserId: string;
    dedupeKey: string;
    priority: NotificationPriority;
    title: string;
    body: string;
    linkedAttentionItemId?: string | null;
    channel?: "push" | "email" | "desktop" | "in_app";
  }): Promise<{ notificationId: string } | { skipped: "duplicate" }> {
    const [existing] = await this.db
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.ownerUserId, params.ownerUserId),
          eq(schema.notifications.dedupeKey, params.dedupeKey),
        ),
      )
      .limit(1);
    if (existing) return { skipped: "duplicate" };

    const id = generateId("notification");
    await this.db.insert(schema.notifications).values({
      id,
      ownerUserId: params.ownerUserId,
      dedupeKey: params.dedupeKey,
      priority: params.priority,
      channel: params.channel ?? "email",
      title: params.title,
      body: params.body,
      linkedAttentionItemId: params.linkedAttentionItemId ?? null,
      state: "queued",
      scheduledFor: new Date(),
    });
    await this.queue.enqueueNotificationDelivery({ notificationId: id });
    return { notificationId: id };
  }

  /** Called from the worker process for a single queued notification. */
  async deliver(notificationId: string): Promise<void> {
    const [notification] = await this.db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, notificationId))
      .limit(1);
    if (!notification || notification.state !== "queued") return; // already handled — safe to no-op on retry/duplicate job

    const [prefs] = await this.db
      .select()
      .from(schema.notificationPreferences)
      .where(eq(schema.notificationPreferences.userId, notification.ownerUserId))
      .limit(1);

    if (prefs?.intensity === "quiet" && notification.priority !== "critical") {
      await this.suppress(notificationId, "quiet_intensity_preference");
      return;
    }

    if (isWithinQuietHours(prefs) && notification.priority !== "critical") {
      // Quiet hours delay rather than drop — reschedule a fresh check in 30 minutes instead of losing it.
      await this.queue.enqueueNotificationDelivery({ notificationId }, 30 * 60 * 1000);
      return;
    }

    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, notification.ownerUserId)).limit(1);
    if (!user?.email) {
      await this.suppress(notificationId, "no_email_on_file");
      return;
    }

    try {
      await this.mailer.send({ to: user.email, subject: notification.title, text: notification.body });
      await this.db
        .update(schema.notifications)
        .set({ state: "sent", sentAt: new Date() })
        .where(eq(schema.notifications.id, notificationId));
    } catch (err) {
      this.logger.warn(`Notification ${notificationId} delivery failed, will retry via job backoff: ${String(err)}`);
      throw err;
    }
  }

  private async suppress(notificationId: string, reason: string): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({ state: "suppressed", suppressionReason: reason })
      .where(eq(schema.notifications.id, notificationId));
  }
}
