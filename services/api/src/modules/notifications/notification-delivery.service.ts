import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { escapeHtml } from "../../common/html-escape";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { EMAIL_PROVIDER, PUSH_PROVIDER, type EmailProvider, type PushProvider } from "./notification-provider.interface";
import { isWithinQuietHours } from "./quiet-hours";

export type NotificationPriority = "critical" | "important" | "useful" | "fyi" | "silent";

/**
 * §33 — notification priority tiers + quiet hours + dedupe. This is the
 * single chokepoint every part of the product goes through to actually
 * notify a user, so suppression rules that ARE implemented (quiet hours,
 * intensity, per-category mute, duplicate dedupe key) live in exactly this
 * one place.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger(NotificationDeliveryService.name);

  /**
   * §NOT-001 — every call site's dedupeKey already follows a stable
   * `<category>:<resource-id>` convention (e.g. "task-assigned:tsk_123",
   * "daily-brief:2026-09-01") to make per-resource dedup possible; reusing
   * that same prefix as the category a `categoryOverrides` entry keys off
   * avoids adding a second, parallel taxonomy (and a schema migration) just
   * to let deliver() know what kind of notification this is.
   */
  private static categoryOf(dedupeKey: string): string {
    const idx = dedupeKey.indexOf(":");
    return idx === -1 ? dedupeKey : dedupeKey.slice(0, idx);
  }

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(EMAIL_PROVIDER) private readonly mailer: EmailProvider,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
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

    // §NOT-001 — a muted category always wins, even over "critical" priority: a user who muted a
    // category made an explicit per-category decision, which is a narrower and more recent signal than
    // the priority tier the notification happened to be created with.
    if (prefs?.categoryOverrides?.[NotificationDeliveryService.categoryOf(notification.dedupeKey)] === "muted") {
      await this.suppress(notificationId, "category_muted");
      return;
    }

    if (prefs?.intensity === "quiet" && notification.priority !== "critical") {
      await this.suppress(notificationId, "quiet_intensity_preference");
      return;
    }

    const [ownerUser] = await this.db.select({ timezone: schema.users.timezone }).from(schema.users).where(eq(schema.users.id, notification.ownerUserId)).limit(1);

    // §NOT-002 "Respect user quiet hours ... critical override only when user opted in and event
    // qualifies" — a critical-priority notification (the "event qualifies" half of that rule; see the
    // priority tiers §33.1 defines and each createAndEnqueue call site's own priority choice) only skips
    // quiet hours when the user has ALSO opted in via `criticalOverridesQuietHours` (the "user opted in"
    // half). Found live via a fresh audit: this previously bypassed quiet hours for every critical
    // notification unconditionally, with no preference anywhere to opt out — defaults to `true` so
    // existing behavior is unchanged for every current user, but the choice now genuinely exists and is
    // enforced (see notifications.service.ts's getPreferences default / dto.ts's allowlist entry).
    const criticalOverride = notification.priority === "critical" && (prefs?.criticalOverridesQuietHours ?? true);
    if (isWithinQuietHours(prefs, new Date(), ownerUser?.timezone) && !criticalOverride) {
      // Quiet hours delay rather than drop — reschedule a fresh check in 30 minutes instead of losing it.
      await this.queue.enqueueNotificationDelivery({ notificationId }, 30 * 60 * 1000);
      return;
    }

    if (notification.channel === "push") {
      const [device] = await this.db
        .select({ pushToken: schema.devices.pushToken })
        .from(schema.devices)
        .where(
          and(
            eq(schema.devices.userId, notification.ownerUserId),
            isNotNull(schema.devices.pushToken),
            isNull(schema.devices.revokedAt),
          ),
        )
        .orderBy(desc(schema.devices.lastActiveAt))
        .limit(1);
      if (device?.pushToken) {
        const sent = await this.push.send(device.pushToken, notification.title, notification.body);
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
    }

    const [user] = await this.db.select().from(schema.users).where(eq(schema.users.id, notification.ownerUserId)).limit(1);
    if (!user?.email) {
      await this.suppress(notificationId, "no_email_on_file");
      return;
    }

    try {
      // Every generator across the product (briefs, task assignment, automation approval, ingestion
      // discoveries) composes only a title/body — none of them included an actual URL, so this email's
      // "Open Veynlo to see the details" had nothing to click (real bug found live via Mailhog: the sent
      // message was plain-text-only with no link anywhere in it). This is the one chokepoint every such
      // notification funnels through on its way to email, so the link — and a real HTML part, previously
      // missing entirely — are added here rather than in each of the seven call sites.
      const webAppUrl = loadEnv().WEB_APP_URL;
      const text = `${notification.body}\n\nOpen Veynlo: ${webAppUrl}/home`;
      const html = `<p>${escapeHtml(notification.body).replace(/\n/g, "<br>")}</p><p><a href="${webAppUrl}/home">Open Veynlo</a></p>`;
      await this.mailer.send({ to: user.email, subject: notification.title, text, html });
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
