import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull, lte } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { MailerService } from "./mailer.service";
import { PushService } from "./push.service";
import { isWithinQuietHours } from "./quiet-hours";

export type NotificationPriority = "critical" | "important" | "useful" | "fyi" | "silent";

const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * §33 — notification priority tiers + quiet hours + dedupe. This is the
 * single chokepoint every part of the product goes through to actually
 * notify a user, so suppression rules — quiet hours, intensity, duplicate
 * dedupe key, and per-category overrides — all live in exactly this one
 * place.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queue: QueueProducerService,
    private readonly mailer: MailerService,
    private readonly push: PushService,
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
    /** Keys into `notificationPreferences.categoryOverrides` (e.g. a domain like "bill"/"purchase", or
     * "daily_brief"/"weekly_brief" for digests). Omitted for notifications with no natural single category. */
    category?: string;
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
      category: params.category ?? null,
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

    // "off" is the one recognized override value — anything else (or no entry at all) means default
    // delivery. Critical notifications still bypass this, same as quiet-hours/intensity above: a
    // category mute is a "don't bother me about this" preference, not a safety-relevant suppression.
    if (notification.category && prefs?.categoryOverrides?.[notification.category] === "off" && notification.priority !== "critical") {
      await this.suppress(notificationId, "category_muted");
      return;
    }

    if (isWithinQuietHours(prefs) && notification.priority !== "critical") {
      // Quiet hours delay rather than drop — reschedule a fresh check in 30 minutes instead of losing it.
      await this.queue.enqueueNotificationDelivery({ notificationId }, 30 * 60 * 1000);
      return;
    }

    if (notification.channel === "push") {
      const sent = await this.sendPush(notification.ownerUserId, notification.title, notification.body, notification.linkedAttentionItemId, notification.id);
      if (sent) {
        await this.db
          .update(schema.notifications)
          .set({ state: "sent", sentAt: new Date() })
          .where(eq(schema.notifications.id, notificationId));
        return;
      }
      // No registered/working push token — fall through to the email path below, same "not configured"
      // degradation as every other optional delivery mechanism rather than silently dropping the notification.
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

  /**
   * Escalation ladder (§NOT-002 follow-up): a critical notification that's been sent but sat
   * unacknowledged for 30+ minutes gets one re-send at distinctly-marked urgency, so it doesn't silently
   * sit unread. escalatedAt gates this to firing at most once per notification — no infinite ladder.
   * Deliberately skips deliver()'s quiet-hours/intensity/category-mute suppression entirely rather than
   * re-running it: those already carve out an explicit bypass for priority === "critical" (see deliver()
   * above), and an escalation only ever fires for critical notifications in the first place.
   */
  async escalateUnacknowledged(): Promise<void> {
    const candidates = await this.db
      .select()
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.priority, "critical"),
          eq(schema.notifications.state, "sent"),
          isNotNull(schema.notifications.sentAt),
          lte(schema.notifications.sentAt, new Date(Date.now() - ESCALATION_THRESHOLD_MS)),
          isNull(schema.notifications.acknowledgedAt),
          isNull(schema.notifications.escalatedAt),
        ),
      );

    for (const notification of candidates) {
      const sent = await this.sendPush(
        notification.ownerUserId,
        `⚠️ Still needs you: ${notification.title}`,
        notification.body,
        notification.linkedAttentionItemId,
        notification.id,
      );
      if (sent) {
        await this.db
          .update(schema.notifications)
          .set({ escalatedAt: new Date() })
          .where(eq(schema.notifications.id, notification.id));
      }
    }
  }

  /** Shared by deliver() and escalateUnacknowledged() — looks up the owner's most-recently-active
   * non-revoked device and sends via PushService, returning false (rather than throwing) if there's no
   * usable push token so callers can fall back accordingly. */
  private async sendPush(
    ownerUserId: string,
    title: string,
    body: string,
    linkedAttentionItemId: string | null,
    notificationId: string,
  ): Promise<boolean> {
    const [device] = await this.db
      .select({ pushToken: schema.devices.pushToken })
      .from(schema.devices)
      .where(and(eq(schema.devices.userId, ownerUserId), isNotNull(schema.devices.pushToken), isNull(schema.devices.revokedAt)))
      .orderBy(desc(schema.devices.lastActiveAt))
      .limit(1);
    if (!device?.pushToken) return false;
    return this.push.send(
      device.pushToken,
      title,
      body,
      linkedAttentionItemId ? { categoryId: "attention_actionable", data: { notificationId, linkedAttentionItemId } } : undefined,
    );
  }

  private async suppress(notificationId: string, reason: string): Promise<void> {
    await this.db
      .update(schema.notifications)
      .set({ state: "suppressed", suppressionReason: reason })
      .where(eq(schema.notifications.id, notificationId));
  }
}
