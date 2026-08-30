import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { getRedisConnection } from "./redis-connection";
import {
  QUEUE_NAMES,
  type ConnectorSyncJobData,
  type ConnectorScanJobData,
  type NotificationDeliveryJobData,
  type NotificationDispatchJobData,
  type AccountDeletionJobData,
  type InboxUnsnoozeScanJobData,
  type AttentionScanJobData,
  type ConnectionDataDeletionJobData,
  type DataExportJobData,
  type DataRetentionScanJobData,
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
  private readonly connectorScanQueue = new Queue<ConnectorScanJobData>(QUEUE_NAMES.connectorScan, {
    connection: getRedisConnection(),
  });
  private readonly notificationDispatchQueue = new Queue<NotificationDispatchJobData>(QUEUE_NAMES.notificationDispatch, {
    connection: getRedisConnection(),
  });
  private readonly notificationDeliveryQueue = new Queue<NotificationDeliveryJobData>(QUEUE_NAMES.notificationDelivery, {
    connection: getRedisConnection(),
  });
  private readonly accountDeletionQueue = new Queue<AccountDeletionJobData>(QUEUE_NAMES.accountDeletion, {
    connection: getRedisConnection(),
  });
  private readonly inboxUnsnoozeQueue = new Queue<InboxUnsnoozeScanJobData>(QUEUE_NAMES.inboxUnsnooze, {
    connection: getRedisConnection(),
  });
  private readonly attentionScanQueue = new Queue<AttentionScanJobData>(QUEUE_NAMES.attentionScan, {
    connection: getRedisConnection(),
  });
  private readonly connectionDataDeletionQueue = new Queue<ConnectionDataDeletionJobData>(QUEUE_NAMES.connectionDataDeletion, {
    connection: getRedisConnection(),
  });
  private readonly dataExportQueue = new Queue<DataExportJobData>(QUEUE_NAMES.dataExport, {
    connection: getRedisConnection(),
  });
  private readonly dataRetentionScanQueue = new Queue<DataRetentionScanJobData>(QUEUE_NAMES.dataRetentionScan, {
    connection: getRedisConnection(),
  });

  async enqueueConnectorSync(data: ConnectorSyncJobData): Promise<void> {
    // Idempotent by jobId: a duplicate enqueue for the same connection+kind while one is already
    // waiting/active is deduplicated by BullMQ rather than piling up redundant syncs. BullMQ (5.81+)
    // rejects custom job IDs containing ":", so this uses "-" as the separator.
    await this.connectorSyncQueue.add("sync", data, {
      jobId: `${data.connectionId}-${data.kind}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    });
  }

  /**
   * Same per-job options as enqueueConnectorSync, but as one BullMQ addBulk round-trip to Redis instead
   * of N sequential adds — the recurring 15-minute scan (worker-main.ts) used to await one enqueue per
   * eligible connection in a plain for-loop, which becomes the scan tick's own bottleneck once there are
   * thousands of connections instead of a handful.
   */
  async enqueueConnectorSyncBulk(items: ConnectorSyncJobData[]): Promise<void> {
    if (items.length === 0) return;
    await this.connectorSyncQueue.addBulk(
      items.map((data) => ({
        name: "sync",
        data,
        opts: {
          jobId: `${data.connectionId}-${data.kind}`,
          attempts: 5,
          backoff: { type: "exponential" as const, delay: 5000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      })),
    );
  }

  /**
   * Registers the recurring tick that drives Gmail incremental sync
   * (§ROADMAP "Gmail incremental/recurring sync"). Connections are created
   * dynamically per user, so this doesn't enqueue per-connection repeat
   * jobs directly — instead one repeatable "scan" tick runs every 15
   * minutes and its processor (worker-main.ts) looks up every healthy
   * Gmail connection and enqueues a `kind: "incremental"` connector-sync
   * job for each.
   */
  async scheduleRecurringConnectorScan(): Promise<void> {
    await this.connectorScanQueue.add(
      "scan",
      {},
      { repeat: { every: 15 * 60 * 1000 }, jobId: "connector-incremental-scan" },
    );
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

  /**
   * Registers the recurring tick that resurfaces snoozed Inbox items once their `snoozedUntil` passes
   * (§INB-002 — snooze is "come back to this later," not "hide this forever"). Mirrors
   * scheduleRecurringConnectorScan's shape: one repeatable tick whose processor (worker-main.ts) does the
   * actual lookup, rather than scheduling a per-item delayed job for every snooze.
   */
  async scheduleRecurringInboxUnsnooze(): Promise<void> {
    await this.inboxUnsnoozeQueue.add("scan", {}, { repeat: { every: 15 * 60 * 1000 }, jobId: "inbox-unsnooze-scan" });
  }

  /**
   * Registers the recurring tick that finds upcoming bill/return/warranty deadlines and files
   * attention_items for them (§HOME-001/004 — previously nothing wrote to that table outside seed data).
   * Hourly rather than the 15-minute cadence of connector-scan/inbox-unsnooze: deadlines here move in
   * days, not minutes, so there's no value in polling more often, just more load.
   */
  async scheduleRecurringAttentionScan(): Promise<void> {
    await this.attentionScanQueue.add("scan", {}, { repeat: { every: 60 * 60 * 1000 }, jobId: "attention-scan" });
  }

  /**
   * PRIV-002 — the actual destructive half of "disconnect and delete" (ConnectorsService.disconnect
   * marks the connection disconnected synchronously; this finishes the real work in the background, same
   * split as account deletion). No delay: disconnection already took effect the moment the request
   * completed, so there's no user-facing grace window this job's timing needs to respect.
   */
  async enqueueConnectionDataDeletion(data: ConnectionDataDeletionJobData): Promise<void> {
    await this.connectionDataDeletionQueue.add("delete", data, {
      jobId: data.connectionId,
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  async enqueueNotificationDelivery(data: NotificationDeliveryJobData, delayMs = 0): Promise<void> {
    await this.notificationDeliveryQueue.add("deliver", data, {
      // Quiet-hours reschedules add a numeric suffix so they don't collide with the (by-then-completed)
      // original attempt's jobId — BullMQ only dedupes against jobs still pending/active/delayed.
      // BullMQ (5.81+) rejects custom job IDs containing ":", so this uses "-" as the separator.
      jobId: delayMs > 0 ? `${data.notificationId}-${Date.now()}` : data.notificationId,
      delay: delayMs,
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /**
   * Account deletion (AppStore/Play Store §5.1.1(v) — in-app self-service deletion). No delay: session
   * revocation already happens synchronously before this is enqueued (IdentityService.requestDeletion),
   * so there's no user-facing "grace window" this job's timing needs to respect — the account is already
   * inaccessible the moment the request completes, and this job just finishes the actual data removal.
   */
  async enqueueAccountDeletion(data: AccountDeletionJobData): Promise<void> {
    await this.accountDeletionQueue.add("delete", data, {
      jobId: data.userId,
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /** PRIV-002 — runs in the background since a user's full data graph can be large. No delay; nothing to wait on. */
  async enqueueDataExport(data: DataExportJobData): Promise<void> {
    await this.dataExportQueue.add("export", data, {
      jobId: data.exportJobId,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    });
  }

  /**
   * PRIV-001 "retention policy settings beyond Documents" — daily is plenty for a setting measured in
   * months, same reasoning as attentionScan's hourly-not-15-minute cadence for deadlines that move in days.
   */
  async scheduleRecurringDataRetentionScan(): Promise<void> {
    await this.dataRetentionScanQueue.add("scan", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "data-retention-scan" });
  }

  /** §Operations "job/queue health monitoring" — the admin console previously only had connection-level
   * (per-connector) and model-level (per-AI-extractor) health, despite the spec explicitly asking for
   * "connector/job/model health." Reuses these same Queue instances (one already exists per queue for
   * enqueueing) rather than opening a second redundant connection just to read counts. */
  async jobCounts(): Promise<Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }>> {
    const queues: Record<string, Queue> = {
      [QUEUE_NAMES.connectorSync]: this.connectorSyncQueue,
      [QUEUE_NAMES.connectorScan]: this.connectorScanQueue,
      [QUEUE_NAMES.notificationDispatch]: this.notificationDispatchQueue,
      [QUEUE_NAMES.notificationDelivery]: this.notificationDeliveryQueue,
      [QUEUE_NAMES.accountDeletion]: this.accountDeletionQueue,
      [QUEUE_NAMES.inboxUnsnooze]: this.inboxUnsnoozeQueue,
      [QUEUE_NAMES.attentionScan]: this.attentionScanQueue,
      [QUEUE_NAMES.connectionDataDeletion]: this.connectionDataDeletionQueue,
      [QUEUE_NAMES.dataExport]: this.dataExportQueue,
      [QUEUE_NAMES.dataRetentionScan]: this.dataRetentionScanQueue,
    };
    const entries = await Promise.all(
      Object.entries(queues).map(async ([name, queue]) => {
        const counts = await queue.getJobCounts("waiting", "active", "completed", "failed", "delayed");
        return [name, counts] as const;
      }),
    );
    return Object.fromEntries(entries) as Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }>;
  }

  async onModuleDestroy() {
    await Promise.all([
      this.connectorSyncQueue.close(),
      this.connectorScanQueue.close(),
      this.notificationDispatchQueue.close(),
      this.notificationDeliveryQueue.close(),
      this.accountDeletionQueue.close(),
      this.inboxUnsnoozeQueue.close(),
      this.attentionScanQueue.close(),
      this.connectionDataDeletionQueue.close(),
      this.dataExportQueue.close(),
      this.dataRetentionScanQueue.close(),
    ]);
  }
}
