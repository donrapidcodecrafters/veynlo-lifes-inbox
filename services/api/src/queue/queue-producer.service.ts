import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { Queue } from "bullmq";
import { getRedisConnection } from "./redis-connection";
import type { QueueProducer } from "./queue-producer.interface";
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
  type InboundEmailIngestJobData,
  type DocumentOcrJobData,
  type VoiceTranscriptionJobData,
  type MemoryClassificationJobData,
  type ResurfacingScanJobData,
  type SchoolSourceSyncJobData,
  type SchoolSourceScanJobData,
  type RecallCheckJobData,
  type RecallScanJobData,
  type CaregiverDayPassScanJobData,
  type LegacyReleaseInactivityScanJobData,
  type DataIntegrityScanJobData,
} from "./queue-names";

/**
 * The only thing the HTTP process should do with a background job is
 * enqueue it — actual execution happens in the worker process
 * (`src/worker-main.ts`), so a Gmail OAuth callback or a notification
 * candidate being created returns immediately instead of blocking on a
 * potentially large mailbox sync or SMTP round-trip.
 */
@Injectable()
export class QueueProducerService implements QueueProducer, OnModuleDestroy {
  private readonly logger = new Logger(QueueProducerService.name);
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
  private readonly inboundEmailIngestQueue = new Queue<InboundEmailIngestJobData>(QUEUE_NAMES.inboundEmailIngest, {
    connection: getRedisConnection(),
  });
  private readonly documentOcrQueue = new Queue<DocumentOcrJobData>(QUEUE_NAMES.documentOcr, {
    connection: getRedisConnection(),
  });
  private readonly voiceTranscriptionQueue = new Queue<VoiceTranscriptionJobData>(QUEUE_NAMES.voiceTranscription, {
    connection: getRedisConnection(),
  });
  private readonly memoryClassificationQueue = new Queue<MemoryClassificationJobData>(QUEUE_NAMES.memoryClassification, {
    connection: getRedisConnection(),
  });
  private readonly resurfacingScanQueue = new Queue<ResurfacingScanJobData>(QUEUE_NAMES.resurfacingScan, {
    connection: getRedisConnection(),
  });
  private readonly schoolSourceSyncQueue = new Queue<SchoolSourceSyncJobData>(QUEUE_NAMES.schoolSourceSync, {
    connection: getRedisConnection(),
  });
  private readonly schoolSourceScanQueue = new Queue<SchoolSourceScanJobData>(QUEUE_NAMES.schoolSourceScan, {
    connection: getRedisConnection(),
  });
  private readonly recallCheckQueue = new Queue<RecallCheckJobData>(QUEUE_NAMES.recallCheck, {
    connection: getRedisConnection(),
  });
  private readonly recallScanQueue = new Queue<RecallScanJobData>(QUEUE_NAMES.recallScan, {
    connection: getRedisConnection(),
  });
  private readonly caregiverDayPassScanQueue = new Queue<CaregiverDayPassScanJobData>(QUEUE_NAMES.caregiverDayPassScan, {
    connection: getRedisConnection(),
  });
  private readonly legacyReleaseInactivityScanQueue = new Queue<LegacyReleaseInactivityScanJobData>(QUEUE_NAMES.legacyReleaseInactivityScan, {
    connection: getRedisConnection(),
  });
  private readonly dataIntegrityScanQueue = new Queue<DataIntegrityScanJobData>(QUEUE_NAMES.dataIntegrityScan, {
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
   * Account deletion (AppStore/Play Store §5.1.1(v) — in-app self-service deletion). PRIV-002 "grace
   * period if used" — `delayMs` (IdentityService.requestDeletion passes the real grace-period length, e.g.
   * 14 days) means this job sits in BullMQ's delayed set and does not become runnable until then, giving
   * `cancelAccountDeletion` below a real window to pull it back. jobId'd by userId exactly as before, so a
   * second `delete-account` call while one is already pending (idempotent no-op in
   * IdentityService.requestDeletion) can't double-enqueue.
   */
  async enqueueAccountDeletion(data: AccountDeletionJobData, delayMs = 0): Promise<void> {
    await this.accountDeletionQueue.add("delete", data, {
      jobId: data.userId,
      delay: delayMs,
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /**
   * PRIV-002 grace period — removes the still-delayed job so it never runs. The overwhelming majority of
   * cancellations hit this while the job is merely delayed/waiting (this only matters within the 14-day
   * grace window at all), which BullMQ removes cleanly. In the narrow race where the grace period expired
   * at essentially the same moment as the cancel request, the job may already be `active` — BullMQ refuses
   * to remove an active job, so this logs a warning and returns rather than throwing: by this point
   * IdentityService.cancelDeletion has already flipped `status` back to "active" in the DB, and there's no
   * user-facing action left to fail: a delete that was already mid-flight before the cancel arrived will
   * simply finish, which is an inherent limit of any last-second cancellation, not a bug in this method.
   */
  async cancelAccountDeletion(userId: string): Promise<void> {
    const job = await this.accountDeletionQueue.getJob(userId);
    if (!job) return; // nothing queued (already ran, or was never enqueued) — nothing to cancel
    const state = await job.getState();
    if (state === "active") {
      this.logger.warn(`Account deletion job for user ${userId} is already active; cannot cancel.`);
      return;
    }
    await job.remove();
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

  /** §11 "never call large AI models synchronously from webhook handlers" — see queue-names.ts's doc
   * comment on InboundEmailIngestJobData for the full story. No custom jobId (unlike the other enqueue
   * methods above): a duplicate webhook delivery is handled by ingestManualText's own idempotencyKey on
   * `source_events`, not by BullMQ deduplication — this job carries no field that's stable/unique across
   * a genuine provider retry the way a connectionId or userId is for the others. */
  async enqueueInboundEmailIngest(data: InboundEmailIngestJobData): Promise<void> {
    await this.inboundEmailIngestQueue.add("ingest", data, {
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /** §28.13 "excessive OCR work" — see queue-names.ts's DocumentOcrJobData doc comment for why this moved
   * off the synchronous upload request. jobId'd by versionId so a duplicate enqueue (there isn't a retry
   * path that would do this today, but matches every other job here) can't double-process one version. */
  async enqueueDocumentOcr(data: DocumentOcrJobData): Promise<void> {
    await this.documentOcrQueue.add("ocr", data, {
      jobId: data.versionId,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /** §52.1 "voice note" transcription — see queue-names.ts's VoiceTranscriptionJobData doc comment. jobId'd
   * by sourceEventId (mirroring enqueueDocumentOcr's jobId-by-versionId shape) so a duplicate enqueue can't
   * double-transcribe the same recording. */
  async enqueueVoiceTranscription(data: VoiceTranscriptionJobData): Promise<void> {
    await this.voiceTranscriptionQueue.add("transcribe", data, {
      jobId: data.sourceEventId,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /** §29.1 SAVE-001/002 — see queue-names.ts's MemoryClassificationJobData doc comment. jobId'd by
   * savedMemoryId so a duplicate enqueue (e.g. a retried request) can't double-classify one memory. */
  async enqueueMemoryClassification(data: MemoryClassificationJobData): Promise<void> {
    await this.memoryClassificationQueue.add("classify", data, {
      jobId: data.savedMemoryId,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /**
   * SAVE-004 "Contextual resurfacing" — mirrors scheduleRecurringAttentionScan's identical shape: one
   * repeatable tick whose processor (ResurfacingService.scanAndFileResurfacing) finds due date/birthday
   * resurfacing rules. Daily, not hourly like attention-scan: resurfacing triggers move in days (a saved
   * date, a birthday countdown), so there's no value polling more often.
   */
  async scheduleRecurringResurfacingScan(): Promise<void> {
    await this.resurfacingScanQueue.add("scan", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "resurfacing-scan" });
  }

  /** §25 SCH-002 — one school/team ICS feed's sync (SchoolIcsService.sync), mirroring enqueueConnectorSync's jobId-dedup shape so a re-subscribe or an overlapping scan tick can't double-sync the same feed concurrently. */
  async enqueueSchoolSourceSync(data: SchoolSourceSyncJobData): Promise<void> {
    await this.schoolSourceSyncQueue.add("sync", data, {
      jobId: data.schoolSourceId,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { count: 200 },
      removeOnFail: { count: 500 },
    });
  }

  /** Mirrors scheduleRecurringConnectorScan's identical shape: one repeatable tick whose processor (worker-main.ts) finds every still-subscribed school_sources row and enqueues a sync for each. */
  async scheduleRecurringSchoolSourceScan(): Promise<void> {
    await this.schoolSourceScanQueue.add("scan", {}, { repeat: { every: 15 * 60 * 1000 }, jobId: "school-source-scan" });
  }

  /** VEH-006/HOMEOS-008 — see queue-names.ts's RecallCheckJobData doc comment. jobId'd by subject so a
   * duplicate enqueue (e.g. creating the vehicle, then immediately hitting "check for recalls" before the
   * first check finishes) can't run two overlapping checks for the same subject. */
  async enqueueRecallCheck(data: RecallCheckJobData): Promise<void> {
    await this.recallCheckQueue.add("check", data, {
      jobId: `${data.subjectType}-${data.subjectId}`,
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { count: 500 },
      removeOnFail: { count: 1000 },
    });
  }

  /**
   * VEH-006/HOMEOS-008 — mirrors scheduleRecurringResurfacingScan's identical shape: one repeatable daily
   * tick whose processor (RecallMonitorService.scanAll) finds every checkable vehicle/home asset itself,
   * re-checking each against NHTSA/CPSC. See queue-names.ts's RecallScanJobData doc comment for the cadence
   * reasoning.
   */
  async scheduleRecurringRecallScan(): Promise<void> {
    await this.recallScanQueue.add("scan", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "recall-scan" });
  }

  /** §35 SHARE-005 "automatically expires" — see queue-names.ts's CaregiverDayPassScanJobData doc comment
   * for the cadence reasoning. */
  async scheduleRecurringCaregiverDayPassScan(): Promise<void> {
    await this.caregiverDayPassScanQueue.add("scan", {}, { repeat: { every: 15 * 60 * 1000 }, jobId: "caregiver-day-pass-scan" });
  }

  /** §35 SHARE-006 legacy-release inactivity trigger — mirrors scheduleRecurringRecallScan's identical
   * daily-cadence shape; see queue-names.ts's LegacyReleaseInactivityScanJobData doc comment for why daily
   * (not attention-scan's hourly) is the right granularity for a day-scale inactivity threshold. */
  async scheduleRecurringLegacyReleaseInactivityScan(): Promise<void> {
    await this.legacyReleaseInactivityScanQueue.add("scan", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "legacy-release-inactivity-scan" });
  }

  /**
   * §Operations "data-integrity/orphan-check job" — finds cross-table links (attention_items/notifications/
   * the JSONB *_entity_ids arrays) whose target row no longer exists (see DataIntegrityService.scanForOrphans).
   * Daily, not hourly like attentionScan: this is a slow-changing signal (rows go orphaned only when
   * something is deleted elsewhere), so there's no value polling more often, just more load.
   */
  async scheduleRecurringDataIntegrityScan(): Promise<void> {
    await this.dataIntegrityScanQueue.add("scan", {}, { repeat: { every: 24 * 60 * 60 * 1000 }, jobId: "data-integrity-scan" });
  }

  /** All queues by name, for read-only inspection (AdminService's queue-health endpoint) — every
   * `enqueue*`/`scheduleRecurring*` method above adds to exactly one of these, kept in the same order. */
  private get queuesByName(): Record<string, Queue> {
    return {
      [QUEUE_NAMES.connectorSync]: this.connectorSyncQueue,
      [QUEUE_NAMES.connectorScan]: this.connectorScanQueue,
      [QUEUE_NAMES.notificationDispatch]: this.notificationDispatchQueue,
      [QUEUE_NAMES.notificationDelivery]: this.notificationDeliveryQueue,
      [QUEUE_NAMES.accountDeletion]: this.accountDeletionQueue,
      [QUEUE_NAMES.inboxUnsnooze]: this.inboxUnsnoozeQueue,
      [QUEUE_NAMES.attentionScan]: this.attentionScanQueue,
      [QUEUE_NAMES.connectionDataDeletion]: this.connectionDataDeletionQueue,
      [QUEUE_NAMES.dataExport]: this.dataExportQueue,
      [QUEUE_NAMES.inboundEmailIngest]: this.inboundEmailIngestQueue,
      [QUEUE_NAMES.documentOcr]: this.documentOcrQueue,
      [QUEUE_NAMES.voiceTranscription]: this.voiceTranscriptionQueue,
      [QUEUE_NAMES.memoryClassification]: this.memoryClassificationQueue,
      [QUEUE_NAMES.resurfacingScan]: this.resurfacingScanQueue,
      [QUEUE_NAMES.schoolSourceSync]: this.schoolSourceSyncQueue,
      [QUEUE_NAMES.schoolSourceScan]: this.schoolSourceScanQueue,
      [QUEUE_NAMES.recallCheck]: this.recallCheckQueue,
      [QUEUE_NAMES.recallScan]: this.recallScanQueue,
      [QUEUE_NAMES.caregiverDayPassScan]: this.caregiverDayPassScanQueue,
      [QUEUE_NAMES.legacyReleaseInactivityScan]: this.legacyReleaseInactivityScanQueue,
      [QUEUE_NAMES.dataIntegrityScan]: this.dataIntegrityScanQueue,
    };
  }

  /**
   * §Operations "connector/job/model health" — job health specifically was previously invisible to
   * support/ops: 11 real BullMQ queues run in Redis with no admin-facing view of depth or failure counts
   * at all, found live via a real audit that had to `redis-cli --scan` directly to confirm they existed.
   * `getJobCounts()` is a cheap read against BullMQ's own Redis-side counters, not a queue drain.
   */
  async getQueueHealth(): Promise<Record<string, { waiting: number; active: number; delayed: number; completed: number; failed: number }>> {
    const entries = await Promise.all(
      Object.entries(this.queuesByName).map(async ([name, queue]) => {
        // BullMQ's own return type is a loose `{ [index: string]: number }` even when specific count
        // types are requested — this cast is safe because exactly these five were asked for above.
        const counts = (await queue.getJobCounts("waiting", "active", "delayed", "completed", "failed")) as {
          waiting: number;
          active: number;
          delayed: number;
          completed: number;
          failed: number;
        };
        return [name, counts] as const;
      }),
    );
    return Object.fromEntries(entries);
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
      this.inboundEmailIngestQueue.close(),
      this.documentOcrQueue.close(),
      this.voiceTranscriptionQueue.close(),
      this.schoolSourceSyncQueue.close(),
      this.schoolSourceScanQueue.close(),
      this.memoryClassificationQueue.close(),
      this.resurfacingScanQueue.close(),
      this.recallCheckQueue.close(),
      this.recallScanQueue.close(),
      this.caregiverDayPassScanQueue.close(),
      this.legacyReleaseInactivityScanQueue.close(),
      this.dataIntegrityScanQueue.close(),
    ]);
  }
}
