import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Logger as PinoLogger } from "nestjs-pino";
import { Worker } from "bullmq";
import { and, eq, inArray, isNotNull, isNull, lte, ne, or } from "drizzle-orm";
import { schema, type Database } from "@veynlo/db";
import { AppModule } from "./app.module";
import { DATABASE } from "./database/database.module";
import { recordAuditEvent } from "./common/audit";
import { getRedisConnection } from "./queue/redis-connection";
import {
  QUEUE_NAMES,
  type AccountDeletionJobData,
  type ConnectorScanJobData,
  type ConnectorSyncJobData,
  type InboxUnsnoozeScanJobData,
  type AttentionScanJobData,
  type ConnectionDataDeletionJobData,
  type NotificationDeliveryJobData,
  type NotificationDispatchJobData,
  type DataExportJobData,
  type DataRetentionScanJobData,
  type NotificationEscalationScanJobData,
  type ExpectedEventScanJobData,
  type DataIntegrityScanJobData,
} from "./queue/queue-names";
import { classifyConnectorError, extractRetryAfterMs } from "./modules/connectors/connector-errors";
import { GmailAdapter } from "./modules/connectors/gmail.adapter";
import { OutlookAdapter } from "./modules/connectors/outlook.adapter";
import { IcsAdapter } from "./modules/connectors/ics.adapter";
import { GoogleCalendarAdapter } from "./modules/connectors/google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./modules/connectors/microsoft-calendar.adapter";
import { GoogleTasksAdapter } from "./modules/connectors/google-tasks.adapter";
import { MicrosoftTodoAdapter } from "./modules/connectors/microsoft-todo.adapter";
import { NotificationDeliveryService } from "./modules/notifications/notification-delivery.service";
import { NotificationDispatchService } from "./modules/notifications/notification-dispatch.service";
import { StorageService } from "./modules/documents/storage.service";
import { AttentionService } from "./modules/attention/attention.service";
import { QueueProducerService } from "./queue/queue-producer.service";
import { DataExportService } from "./modules/data-export/data-export.service";
import { FeatureFlagsService } from "./modules/feature-flags/feature-flags.service";
import { DataIntegrityService } from "./modules/data-integrity/data-integrity.service";

const logger = new Logger("Worker");

/**
 * A second bootstrap for the SAME Nest project (§42.5: durable background
 * work must survive a process restart, not run inline on an HTTP request).
 * This process has no HTTP server — `createApplicationContext` gives it
 * the exact same DI graph as `main.ts` (same services, same DB connection
 * config) purely so job processors can call into GmailAdapter/OutlookAdapter/Notification*
 * without duplicating that logic in a second codebase. Deploy this as its
 * own process (`pnpm --filter @veynlo/api run start:worker`) alongside the
 * HTTP process, not instead of it.
 */
async function bootstrap() {
  const appContext = await NestFactory.createApplicationContext(AppModule, { bufferLogs: true });
  appContext.useLogger(appContext.get(PinoLogger));

  const db = appContext.get<Database>(DATABASE);
  const gmailAdapter = appContext.get(GmailAdapter);
  const outlookAdapter = appContext.get(OutlookAdapter);
  const icsAdapter = appContext.get(IcsAdapter);
  const googleCalendarAdapter = appContext.get(GoogleCalendarAdapter);
  const microsoftCalendarAdapter = appContext.get(MicrosoftCalendarAdapter);
  const googleTasksAdapter = appContext.get(GoogleTasksAdapter);
  const microsoftTodoAdapter = appContext.get(MicrosoftTodoAdapter);
  const notificationDelivery = appContext.get(NotificationDeliveryService);
  const notificationDispatch = appContext.get(NotificationDispatchService);
  const storage = appContext.get(StorageService);
  const attention = appContext.get(AttentionService);
  const queueProducer = appContext.get(QueueProducerService);
  const dataExport = appContext.get(DataExportService);
  const featureFlags = appContext.get(FeatureFlagsService);
  const dataIntegrity = appContext.get(DataIntegrityService);

  const connectorSyncWorker = new Worker<ConnectorSyncJobData>(
    QUEUE_NAMES.connectorSync,
    async (job) => {
      const { connectionId, kind } = job.data;
      try {
        const [connection] = await db
          .select({ provider: schema.connections.provider })
          .from(schema.connections)
          .where(eq(schema.connections.id, connectionId))
          .limit(1);
        if (!connection) throw new Error(`Connection ${connectionId} not found`);
        // §Operations "feature flags" — real per-provider emergency kill switch: unconfigured (no row)
        // means the flag is off, which for a "_disabled" key means sync runs normally. An admin flipping
        // `connector_sync_${provider}_disabled` to true (e.g. mid-incident, a provider API is misbehaving
        // or a partner relationship needs a pause) makes every subsequent sync job for that provider a
        // silent no-op rather than retrying into an outage. Job still completes (not thrown), so BullMQ
        // doesn't treat a deliberate pause as a failure needing retry/backoff.
        if (await featureFlags.isEnabled(`connector_sync_${connection.provider}_disabled`)) {
          logger.warn(`Skipping sync for connection ${connectionId} — connector_sync_${connection.provider}_disabled is on.`);
          return;
        }
        const adapter =
          connection.provider === "outlook"
            ? outlookAdapter
            : connection.provider === "ics"
              ? icsAdapter
              : connection.provider === "google_calendar"
                ? googleCalendarAdapter
                : connection.provider === "microsoft_calendar"
                  ? microsoftCalendarAdapter
                  : connection.provider === "google_tasks"
                    ? googleTasksAdapter
                    : connection.provider === "microsoft_todo"
                      ? microsoftTodoAdapter
                      : gmailAdapter;
        if (kind === "incremental") {
          await adapter.incrementalSync(connectionId);
        } else {
          await adapter.initialSync(connectionId);
        }
      } catch (err) {
        // §54.2 launch criteria #6 — classify before recording, so the UI's already-built distinct badges
        // for rate_limited/reauth_required/provider_outage (previously dead states — everything landed on
        // "degraded" regardless of cause) actually reflect what went wrong.
        const health = classifyConnectorError(err);
        const retryAfterMs = health === "rate_limited" ? extractRetryAfterMs(err) : null;
        await db
          .update(schema.connections)
          .set({
            health,
            healthDetail: String((err as Error)?.message ?? err),
            // A real Retry-After only ever pushes the connector-scan recovery tick's eligibility further
            // out than its flat cooldown would alone — see that query below and extractRetryAfterMs' own
            // comment. Cleared (not left stale) on any non-rate_limited failure or success.
            retryNotBeforeAt: retryAfterMs ? new Date(Date.now() + retryAfterMs) : null,
            updatedAt: new Date(),
          })
          .where(eq(schema.connections.id, connectionId));
        throw err; // let BullMQ's retry/backoff attempt again before giving up
      }
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  // Recurring tick (see QueueProducerService.scheduleRecurringConnectorScan): finds every still-connected
  // direct-API/feed connection (Gmail, Outlook, ICS, Google Calendar) and enqueues one incremental sync per
  // connection. Deduplicated by enqueueConnectorSync's jobId (`${connectionId}-incremental`), so a
  // connection already mid-sync when this tick fires is just skipped rather than double-queued.
  //
  // Real gap this closes: a connection that exhausts BullMQ's 5 retry attempts and lands on a non-healthy
  // status (rate_limited/reauth_required/provider_outage/degraded — see classifyConnectorError) used to be
  // PERMANENTLY excluded from every future tick, since this query only ever selected health="healthy".
  // Nothing else in the codebase ever re-included it — a transient rate-limit or a single provider outage
  // became a silently-dead connector forever, with no path back to healthy short of the user manually
  // disconnecting and fully re-authorizing. Now also retries the recoverable non-healthy states, gated by a
  // cooldown (skip anything that failed within the last half hour) so a connection that just failed on this
  // same tick cycle isn't hammered again a few seconds later — it gets picked back up on a later tick
  // instead, giving it a real, ongoing chance to self-heal (a rate limit clears, a transient 5xx passes,
  // token refresh starts working again) rather than a one-shot backoff that gives up forever.
  const RECOVERABLE_CONNECTOR_HEALTH_STATES = ["rate_limited", "reauth_required", "provider_outage", "degraded"];
  const CONNECTOR_RETRY_COOLDOWN_MS = 30 * 60 * 1000;
  const CONNECTOR_SCAN_BATCH_LIMIT = 5000;
  const connectorScanWorker = new Worker<ConnectorScanJobData>(
    QUEUE_NAMES.connectorScan,
    async () => {
      const eligible = await db
        .select({ id: schema.connections.id })
        .from(schema.connections)
        .where(
          and(
            inArray(schema.connections.provider, [
              "gmail",
              "outlook",
              "ics",
              "google_calendar",
              "microsoft_calendar",
              "google_tasks",
              "microsoft_todo",
            ]),
            or(
              eq(schema.connections.health, "healthy"),
              and(
                inArray(schema.connections.health, RECOVERABLE_CONNECTOR_HEALTH_STATES),
                lte(schema.connections.updatedAt, new Date(Date.now() - CONNECTOR_RETRY_COOLDOWN_MS)),
                // A captured Retry-After (rate_limited only — see the failure handler above) can push
                // eligibility out further than the flat cooldown alone; null for anything else, which
                // makes this condition vacuously true and leaves the flat cooldown as the sole gate.
                or(isNull(schema.connections.retryNotBeforeAt), lte(schema.connections.retryNotBeforeAt, new Date())),
              ),
            ),
            isNull(schema.connections.disconnectedAt),
          ),
        )
        // A tick that found more than this is at real scale — jobId-based dedup means anything left over
        // just gets picked up on the next 15-minute tick instead of ever being dropped, so this is a
        // throughput cap, not a correctness one. Logged rather than silently truncated.
        .limit(CONNECTOR_SCAN_BATCH_LIMIT);
      if (eligible.length === CONNECTOR_SCAN_BATCH_LIMIT) {
        logger.warn(`Eligible connections hit the ${CONNECTOR_SCAN_BATCH_LIMIT} batch cap — some will roll to the next tick.`);
      }
      await queueProducer.enqueueConnectorSyncBulk(eligible.map((connection) => ({ connectionId: connection.id, kind: "incremental" as const })));
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  const notificationDispatchWorker = new Worker<NotificationDispatchJobData>(
    QUEUE_NAMES.notificationDispatch,
    async (job) => {
      if (job.data.brief === "daily") await notificationDispatch.dispatchDailyBrief();
      else await notificationDispatch.dispatchWeeklyBrief();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  const notificationDeliveryWorker = new Worker<NotificationDeliveryJobData>(
    QUEUE_NAMES.notificationDelivery,
    async (job) => {
      await notificationDelivery.deliver(job.data.notificationId);
    },
    { connection: getRedisConnection(), concurrency: 8 },
  );

  /**
   * The actual data-removal half of account deletion (see IdentityService.requestDeletion for the
   * synchronous half — password verification, household-ownership blocking, immediate session revocation).
   * Runs in the background because a user's owned data graph (source events, entities, documents,
   * purchases, automations, etc.) can be large; nearly all of it cascades away via `onDelete: "cascade"`
   * FKs to users.id once the row itself is deleted, so this job's own job is mostly: handle the one FK
   * that deliberately does NOT cascade (households.billingOwnerUserId), delete the user row, then clean
   * up the one thing outside Postgres entirely (S3 document blobs).
   */
  const accountDeletionWorker = new Worker<AccountDeletionJobData>(
    QUEUE_NAMES.accountDeletion,
    async (job) => {
      const { userId } = job.data;

      const ownedHouseholds = await db
        .select({ id: schema.households.id })
        .from(schema.households)
        .where(eq(schema.households.billingOwnerUserId, userId));

      const soloHouseholdIds: string[] = [];
      for (const household of ownedHouseholds) {
        // requestDeletion() already checked this synchronously before enqueueing — re-checked here in
        // case household membership changed in the window between request and processing.
        const [otherActiveMember] = await db
          .select({ id: schema.householdMemberships.id })
          .from(schema.householdMemberships)
          .where(
            and(
              eq(schema.householdMemberships.householdId, household.id),
              eq(schema.householdMemberships.status, "active"),
              ne(schema.householdMemberships.userId, userId),
            ),
          )
          .limit(1);
        if (otherActiveMember) {
          logger.error(
            `Account deletion for user ${userId} blocked: household ${household.id} gained another active member after the request was accepted. Leaving the account in deletion_pending for manual resolution.`,
          );
          return; // don't retry — this needs a human, not a backoff
        }
        soloHouseholdIds.push(household.id);
      }

      const blobs = await db
        .select({ blobRef: schema.documentVersions.blobRef })
        .from(schema.documentVersions)
        .innerJoin(schema.documents, eq(schema.documents.id, schema.documentVersions.documentId))
        .where(eq(schema.documents.ownerUserId, userId));

      // Households with no other active member cascade away entirely once deleted (memberships,
      // dependents, etc. all reference households.id with onDelete: "cascade"). Must happen before the
      // user row is deleted — billingOwnerUserId has no onDelete action, so it would otherwise block it.
      for (const id of soloHouseholdIds) {
        await db.delete(schema.households).where(eq(schema.households.id, id));
      }
      await db.delete(schema.users).where(eq(schema.users.id, userId));

      // search_documents.ownerUserId is a bare text column, not a `references(users.id)` FK — nothing
      // cascades this on user deletion, so it needs an explicit delete here or a search index row survives
      // forever for an account that no longer exists.
      await db.delete(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, userId));

      // Not itself a FK to users.id (actorId is a bare string column) — survives the delete above by design.
      await recordAuditEvent(db, { actorType: "system", actorId: userId, action: "account_deletion", resourceType: "user", resourceId: userId });

      for (const { blobRef } of blobs) {
        try {
          await storage.deleteObject(blobRef);
        } catch (err) {
          logger.error(`Failed to delete S3 object ${blobRef} for deleted user ${userId}: ${String((err as Error)?.message ?? err)}`);
        }
      }
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  /**
   * PRIV-002 — the actual deletion half of "disconnect and delete" (ConnectorsService.disconnect marks
   * the connection disconnected synchronously; this does the real work). Only two domain tables trace
   * back to a connection directly (purchases.sourceEventId); bills/warranties/calendar_events/shipments
   * have no such column, so they're found indirectly via inbox_items — every successful extraction files
   * one (IngestionService.fileInboxItem), and nothing in the app hard-deletes an inbox_item, so that
   * mapping is reliable. Deletes purchases first so return_cases/shipments/purchase_lines that FK to them
   * cascade away automatically; captures purchaseLines.ownerAssetEntityId beforehand since
   * canonical_entities has no matching cascade and would otherwise orphan. Also clears any attention_item
   * pointing at something about to be deleted, so "Needs You" never shows a card for data that no longer
   * exists. Documents are deliberately out of scope — they're user-uploaded (documents.service.ts's
   * upload()), not connector-derived, so a connection has none to delete.
   */
  const connectionDataDeletionWorker = new Worker<ConnectionDataDeletionJobData>(
    QUEUE_NAMES.connectionDataDeletion,
    async (job) => {
      const { connectionId, ownerUserId } = job.data;
      const sourceEventRows = await db
        .select({ id: schema.sourceEvents.id })
        .from(schema.sourceEvents)
        .where(eq(schema.sourceEvents.connectionId, connectionId));
      const sourceEventIds = sourceEventRows.map((r) => r.id);
      if (sourceEventIds.length === 0) return;

      const purchases = await db.select({ id: schema.purchases.id }).from(schema.purchases).where(inArray(schema.purchases.sourceEventId, sourceEventIds));
      const purchaseIds = purchases.map((p) => p.id);
      if (purchaseIds.length > 0) {
        const lines = await db
          .select({ ownerAssetEntityId: schema.purchaseLines.ownerAssetEntityId })
          .from(schema.purchaseLines)
          .where(inArray(schema.purchaseLines.purchaseId, purchaseIds));
        const entityIds = lines.map((l) => l.ownerAssetEntityId).filter((id): id is string => id != null);
        await db.delete(schema.purchases).where(inArray(schema.purchases.id, purchaseIds));
        if (entityIds.length > 0) await db.delete(schema.canonicalEntities).where(inArray(schema.canonicalEntities.id, entityIds));
      }

      const inboxRows = await db
        .select({ linkedResourceType: schema.inboxItems.linkedResourceType, linkedResourceId: schema.inboxItems.linkedResourceId })
        .from(schema.inboxItems)
        .where(inArray(schema.inboxItems.sourceEventId, sourceEventIds));
      const idsFor = (type: string) => inboxRows.filter((r) => r.linkedResourceType === type && r.linkedResourceId).map((r) => r.linkedResourceId as string);
      const billIds = idsFor("bill");
      const warrantyIds = idsFor("warranty");
      const calendarEventIds = idsFor("calendar_event");
      const shipmentIds = idsFor("shipment");
      const taskIds = idsFor("task");
      if (billIds.length > 0) await db.delete(schema.bills).where(inArray(schema.bills.id, billIds));
      if (warrantyIds.length > 0) await db.delete(schema.warranties).where(inArray(schema.warranties.id, warrantyIds));
      if (calendarEventIds.length > 0) await db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, calendarEventIds));
      if (shipmentIds.length > 0) await db.delete(schema.shipments).where(inArray(schema.shipments.id, shipmentIds));
      if (taskIds.length > 0) await db.delete(schema.tasks).where(inArray(schema.tasks.id, taskIds));

      const allLinkedIds = [...purchaseIds, ...billIds, ...warrantyIds, ...calendarEventIds, ...shipmentIds, ...taskIds];
      if (allLinkedIds.length > 0) {
        await db.delete(schema.attentionItems).where(inArray(schema.attentionItems.linkedResourceId, allLinkedIds));
        // Resource IDs are opaque and prefix-unique across types, so one IN(...) covers whichever of these
        // (purchases/bills/calendarEvents — the only three types search_documents indexes) are present.
        await db.delete(schema.searchDocuments).where(inArray(schema.searchDocuments.resourceId, allLinkedIds));
      }

      await db.delete(schema.inboxItems).where(inArray(schema.inboxItems.sourceEventId, sourceEventIds));
      await db.delete(schema.sourceEvents).where(inArray(schema.sourceEvents.id, sourceEventIds));

      await recordAuditEvent(db, {
        actorType: "user",
        actorId: ownerUserId,
        action: "connection.delete_derived_data",
        resourceType: "connection",
        resourceId: connectionId,
        beforeJson: { sourceEventCount: sourceEventIds.length, purchaseCount: purchaseIds.length },
      });
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  // Recurring tick (see QueueProducerService.scheduleRecurringInboxUnsnooze): resurfaces every snoozed
  // Inbox item whose snoozedUntil has passed by flipping it back to reviewState "new" — snooze() itself
  // only ever sets reviewState to "snoozed", so without this tick a snoozed item would stay hidden
  // forever instead of coming back for review as the user intended.
  const inboxUnsnoozeWorker = new Worker<InboxUnsnoozeScanJobData>(
    QUEUE_NAMES.inboxUnsnooze,
    async () => {
      await db
        .update(schema.inboxItems)
        .set({ reviewState: "new", snoozedUntil: null, updatedAt: new Date() })
        .where(and(eq(schema.inboxItems.reviewState, "snoozed"), lte(schema.inboxItems.snoozedUntil, new Date())));
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  const attentionScanWorker = new Worker<AttentionScanJobData>(
    QUEUE_NAMES.attentionScan,
    async () => {
      await attention.scanAndFileDeadlines();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** PRIV-002 — gathers the user's full manifest (DataExportService.buildManifest), uploads it as a single JSON object, and marks the job completed/failed accordingly. */
  const dataExportWorker = new Worker<DataExportJobData>(
    QUEUE_NAMES.dataExport,
    async (job) => {
      const { exportJobId, userId } = job.data;
      await db.update(schema.exportJobs).set({ state: "processing" }).where(eq(schema.exportJobs.id, exportJobId));
      try {
        const manifest = await dataExport.buildManifest(userId);
        const storageKey = dataExport.storageKeyFor(userId, exportJobId);
        await storage.putObject(storageKey, Buffer.from(JSON.stringify(manifest, null, 2)), "application/json");
        await db
          .update(schema.exportJobs)
          .set({ state: "completed", storageKey, completedAt: new Date(), expiresAt: new Date(Date.now() + dataExport.ttlMs()) })
          .where(eq(schema.exportJobs.id, exportJobId));
      } catch (err) {
        await db
          .update(schema.exportJobs)
          .set({ state: "failed", errorMessage: String((err as Error)?.message ?? err) })
          .where(eq(schema.exportJobs.id, exportJobId));
        throw err;
      }
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  /**
   * PRIV-001 "retention policy settings beyond Documents" — redacts (never deletes the row, which
   * purchases/bills/calendar_events/etc. may still reference via sourceEventId) the raw evidence fields
   * on source_events/evidence_refs once they're older than the owning user's `dataRetentionDays`. Every
   * derived structured record (the actual purchase/bill/task) stays untouched — this only clears the
   * original raw subject/snippet/from-address/content-ref, the same "keep what was extracted, drop the
   * original" posture as DocumentsService.setRetention's non-"full_original" policies.
   */
  const dataRetentionScanWorker = new Worker<DataRetentionScanJobData>(
    QUEUE_NAMES.dataRetentionScan,
    async () => {
      const usersWithRetention = await db
        .select({ id: schema.users.id, dataRetentionDays: schema.users.dataRetentionDays })
        .from(schema.users)
        .where(isNotNull(schema.users.dataRetentionDays));
      for (const user of usersWithRetention) {
        const cutoff = new Date(Date.now() - user.dataRetentionDays! * 86_400_000);
        const staleEvents = await db
          .select({ id: schema.sourceEvents.id })
          .from(schema.sourceEvents)
          .where(
            and(
              eq(schema.sourceEvents.ownerUserId, user.id),
              lte(schema.sourceEvents.receivedAt, cutoff),
              or(
                isNotNull(schema.sourceEvents.rawContentRef),
                isNotNull(schema.sourceEvents.subjectLine),
                isNotNull(schema.sourceEvents.snippet),
                isNotNull(schema.sourceEvents.fromAddress),
              ),
            ),
          );
        if (staleEvents.length === 0) continue;
        const staleEventIds = staleEvents.map((e) => e.id);
        await db
          .update(schema.sourceEvents)
          .set({ rawContentRef: null, subjectLine: null, snippet: null, fromAddress: null })
          .where(inArray(schema.sourceEvents.id, staleEventIds));
        await db.update(schema.evidenceRefs).set({ excerpt: null }).where(inArray(schema.evidenceRefs.sourceEventId, staleEventIds));
      }
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  const notificationEscalationScanWorker = new Worker<NotificationEscalationScanJobData>(
    QUEUE_NAMES.notificationEscalationScan,
    async () => {
      await notificationDelivery.escalateUnacknowledged();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  const expectedEventScanWorker = new Worker<ExpectedEventScanJobData>(
    QUEUE_NAMES.expectedEventScan,
    async () => {
      await attention.scanForMissingExpectedEvents();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  const dataIntegrityScanWorker = new Worker<DataIntegrityScanJobData>(
    QUEUE_NAMES.dataIntegrityScan,
    async () => {
      await dataIntegrity.scanForOrphans();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  for (const worker of [
    connectorSyncWorker,
    connectorScanWorker,
    notificationDispatchWorker,
    notificationDeliveryWorker,
    accountDeletionWorker,
    connectionDataDeletionWorker,
    inboxUnsnoozeWorker,
    attentionScanWorker,
    dataExportWorker,
    dataRetentionScanWorker,
    notificationEscalationScanWorker,
    expectedEventScanWorker,
    dataIntegrityScanWorker,
  ]) {
    worker.on("failed", (job, err) => logger.error(`Job ${job?.queueName}/${job?.id} failed: ${err.message}`));
    worker.on("completed", (job) => logger.log(`Job ${job.queueName}/${job.id} completed`));
  }

  // Registers the repeatable daily/weekly brief jobs, the connector incremental-scan tick, and the inbox
  // unsnooze tick (idempotent — BullMQ dedupes repeat jobs by jobId).
  await queueProducer.scheduleRecurringNotificationDispatch();
  await queueProducer.scheduleRecurringConnectorScan();
  await queueProducer.scheduleRecurringInboxUnsnooze();
  await queueProducer.scheduleRecurringAttentionScan();
  await queueProducer.scheduleRecurringDataRetentionScan();
  await queueProducer.scheduleRecurringNotificationEscalationScan();
  await queueProducer.scheduleRecurringExpectedEventScan();
  await queueProducer.scheduleRecurringDataIntegrityScan();

  logger.log(
    "Veynlo worker process started — processing connector-sync, connector-scan, notification-dispatch, notification-delivery, account-deletion, connection-data-deletion, inbox-unsnooze, attention-scan, data-export, data-retention-scan, notification-escalation-scan, expected-event-scan, data-integrity-scan",
  );

  const shutdown = async () => {
    logger.log("Shutting down worker process...");
    await Promise.all([
      connectorSyncWorker.close(),
      connectorScanWorker.close(),
      notificationDispatchWorker.close(),
      notificationDeliveryWorker.close(),
      accountDeletionWorker.close(),
      connectionDataDeletionWorker.close(),
      inboxUnsnoozeWorker.close(),
      attentionScanWorker.close(),
      dataExportWorker.close(),
      dataRetentionScanWorker.close(),
      notificationEscalationScanWorker.close(),
      expectedEventScanWorker.close(),
      dataIntegrityScanWorker.close(),
    ]);
    await appContext.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

bootstrap();
