import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { getRedisConnection } from "./redis-connection";
import {
  QUEUE_NAMES,
  type ConnectorSyncJobData,
  type NotificationDeliveryJobData,
  type NotificationDispatchJobData,
} from "./queue-names";

/**
 * The only thing the HTTP process should do with a background job is
 * enqueue it — actual execution happens in the worker process
 * (`src/worker-main.ts`), so a Gmail OAuth callback or a notification
 * candidate being created returns immediately instead of blocking on a
 * potentially large mailbox sync or SMTP round-trip.
 */
@Injectable()
export class QueueProducerService implements OnModuleDestroy {
  private readonly connectorSyncQueue = new Queue<ConnectorSyncJobData>(QUEUE_NAMES.connectorSync, {
    connection: getRedisConnection(),
  });
  private readonly notificationDispatchQueue = new Queue<NotificationDispatchJobData>(QUEUE_NAMES.notificationDispatch, {
    connection: getRedisConnection(),
  });
  private readonly notificationDeliveryQueue = new Queue<NotificationDeliveryJobData>(QUEUE_NAMES.notificationDelivery, {
    connection: getRedisConnection(),
  });

  async enqueueConnectorSync(data: ConnectorSyncJobData): Promise<void> {
    // Idempotent by jobId: a duplicate enqueue for the same connection+kind while one is already
    // waiting/active is deduplicated by BullMQ rather than piling up redundant syncs.
    await this.connectorSyncQueue.add("sync", data, {
      jobId: `${data.connectionId}:${data.kind}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    });
  }

  async scheduleRecurringNotificationDispatch(): Promise<void> {
    await this.notificationDispatchQueue.add(
      "daily",
      { brief: "daily" },
      { repeat: { pattern: "0 13 * * *" }, jobId: "daily-brief-dispatch" }, // 13:00 UTC ≈ common morning window across US timezones; per-user local-time targeting is a follow-up
    );
    await this.notificationDispatchQueue.add(
      "weekly",
      { brief: "weekly" },
      { repeat: { pattern: "0 13 * * 1" }, jobId: "weekly-brief-dispatch" },
    );
  }

  async enqueueNotificationDelivery(data: NotificationDeliveryJobData, delayMs = 0): Promise<void> {
    await this.notificationDeliveryQueue.add("deliver", data, {
      // Quiet-hours reschedules add a numeric suffix so they don't collide with the (by-then-completed)
      // original attempt's jobId — BullMQ only dedupes against jobs still pending/active/delayed.
      jobId: delayMs > 0 ? `${data.notificationId}:${Date.now()}` : data.notificationId,
      delay: delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  async onModuleDestroy() {
    await Promise.all([
      this.connectorSyncQueue.close(),
      this.notificationDispatchQueue.close(),
      this.notificationDeliveryQueue.close(),
    ]);
  }
}
