import "./config/load-env-file"; // must be the first import — see its own doc comment for why
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Logger as PinoLogger } from "nestjs-pino";
import { Worker } from "bullmq";
import { and, eq, inArray, isNull, lte, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import { schema, type Database } from "@veynlo/db";
import { AppModule } from "./app.module";
import { DATABASE } from "./database/database.module";
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
  type InboundEmailIngestJobData,
  type DocumentOcrJobData,
  type VoiceTranscriptionJobData,
  type SchoolSourceSyncJobData,
  type SchoolSourceScanJobData,
  type RecallCheckJobData,
  type RecallScanJobData,
  type CaregiverDayPassScanJobData,
  type MemoryClassificationJobData,
  type ResurfacingScanJobData,
  type LegacyReleaseInactivityScanJobData,
  type DataIntegrityScanJobData,
} from "./queue/queue-names";
import { GmailAdapter } from "./modules/connectors/gmail.adapter";
import { OutlookAdapter } from "./modules/connectors/outlook.adapter";
import { IcsAdapter } from "./modules/connectors/ics.adapter";
import { GoogleCalendarAdapter } from "./modules/connectors/google-calendar.adapter";
import { MicrosoftCalendarAdapter } from "./modules/connectors/microsoft-calendar.adapter";
import { GoogleDriveAdapter } from "./modules/connectors/google-drive.adapter";
import { OneDriveAdapter } from "./modules/connectors/onedrive.adapter";
import { DropboxAdapter } from "./modules/connectors/dropbox.adapter";
import { GoogleTasksAdapter } from "./modules/connectors/google-tasks.adapter";
import { MicrosoftToDoAdapter } from "./modules/connectors/microsoft-todo.adapter";
import { PlaidAdapter } from "./modules/connectors/plaid.adapter";
import { NotificationDeliveryService } from "./modules/notifications/notification-delivery.service";
import { NotificationDispatchService } from "./modules/notifications/notification-dispatch.service";
import { OBJECT_STORAGE, type ObjectStorage } from "./modules/documents/object-storage.interface";
import { AttentionService } from "./modules/attention/attention.service";
import { FinanceService } from "./modules/finance/finance.service";
import { QueueProducerService } from "./queue/queue-producer.service";
import { DataExportService } from "./modules/data-export/data-export.service";
import { IngestionService } from "./modules/ingestion/ingestion.service";
import { DocumentsService } from "./modules/documents/documents.service";
import { SchoolIcsService } from "./modules/school/school-ics.service";
import { RecallMonitorService } from "./modules/assets/recall-monitor.service";
import { MemoriesService } from "./modules/memories/memories.service";
import { ResurfacingService } from "./modules/memories/resurfacing.service";
import { ConnectorsService } from "./modules/connectors/connectors.service";
import { CaregiverDayPassService } from "./modules/sharing/caregiver-day-pass.service";
import { recordConnectorSyncFailure, providerFamilyFor } from "./modules/connectors/connection-health.util";
import { LegacyReleaseService } from "./modules/sharing/legacy-release.service";
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
  const googleDriveAdapter = appContext.get(GoogleDriveAdapter);
  const oneDriveAdapter = appContext.get(OneDriveAdapter);
  const dropboxAdapter = appContext.get(DropboxAdapter);
  const googleTasksAdapter = appContext.get(GoogleTasksAdapter);
  const microsoftToDoAdapter = appContext.get(MicrosoftToDoAdapter);
  const plaidAdapter = appContext.get(PlaidAdapter);
  const notificationDelivery = appContext.get(NotificationDeliveryService);
  const notificationDispatch = appContext.get(NotificationDispatchService);
  const storage = appContext.get<ObjectStorage>(OBJECT_STORAGE);
  const attention = appContext.get(AttentionService);
  const finance = appContext.get(FinanceService);
  const queueProducer = appContext.get(QueueProducerService);
  const dataExport = appContext.get(DataExportService);
  const ingestion = appContext.get(IngestionService);
  const documents = appContext.get(DocumentsService);
  const schoolIcs = appContext.get(SchoolIcsService);
  const recallMonitor = appContext.get(RecallMonitorService);
  const memories = appContext.get(MemoriesService);
  const resurfacing = appContext.get(ResurfacingService);
  const connectors = appContext.get(ConnectorsService);
  const caregiverDayPasses = appContext.get(CaregiverDayPassService);
  const legacyRelease = appContext.get(LegacyReleaseService);
  const dataIntegrity = appContext.get(DataIntegrityService);

  const connectorSyncWorker = new Worker<ConnectorSyncJobData>(
    QUEUE_NAMES.connectorSync,
    async (job) => {
      const { connectionId, kind } = job.data;
      // Captured outside the try so the catch below can still classify a failure that happens AFTER the
      // connection row was found (the overwhelmingly common case) — see recordConnectorSyncFailure's own
      // doc comment for why this needs to know which provider's error vocabulary to interpret the thrown
      // error against.
      let provider: string | undefined;
      try {
        const [connection] = await db
          .select({ provider: schema.connections.provider })
          .from(schema.connections)
          .where(eq(schema.connections.id, connectionId))
          .limit(1);
        if (!connection) throw new Error(`Connection ${connectionId} not found`);
        provider = connection.provider;
        const adapter =
          connection.provider === "outlook"
            ? outlookAdapter
            : connection.provider === "ics"
              ? icsAdapter
              : connection.provider === "google_calendar"
                ? googleCalendarAdapter
                : connection.provider === "microsoft_calendar"
                  ? microsoftCalendarAdapter
                  : connection.provider === "google_drive"
                    ? googleDriveAdapter
                    : connection.provider === "onedrive"
                      ? oneDriveAdapter
                      : connection.provider === "dropbox"
                        ? dropboxAdapter
                        : connection.provider === "google_tasks"
                          ? googleTasksAdapter
                          : connection.provider === "microsoft_todo"
                            ? microsoftToDoAdapter
                            : connection.provider === "plaid"
                              ? plaidAdapter
                              : gmailAdapter;
        if (kind === "incremental") {
          await adapter.incrementalSync(connectionId);
        } else {
          await adapter.initialSync(connectionId);
        }
      } catch (err) {
        // §43.3 "Connection health model" — replaces the old unconditional `health: "degraded"` write with
        // real classification (reauth_required / rate_limited / permission_reduced / provider_outage,
        // falling back to degraded only when nothing more specific matched). See
        // connection-health.util.ts's own doc comment for why this is centralized here rather than
        // duplicated per adapter.
        await recordConnectorSyncFailure(db, connectionId, err, providerFamilyFor(provider));
        throw err; // let BullMQ's retry/backoff attempt again before giving up
      }
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  // Recurring tick (see QueueProducerService.scheduleRecurringConnectorScan): finds every healthy,
  // still-connected direct-API/feed connection (Gmail, Outlook, ICS, Google/Microsoft Calendar, Google
  // Drive, OneDrive, Dropbox, Google Tasks, Microsoft To Do, Plaid) and enqueues one
  // incremental sync per connection. Deduplicated by enqueueConnectorSync's jobId
  // (`${connectionId}-incremental`), so a connection already mid-sync when this tick fires is just skipped
  // rather than double-queued.
  const connectorScanWorker = new Worker<ConnectorScanJobData>(
    QUEUE_NAMES.connectorScan,
    async () => {
      // PRIV-001 "pause a connection's processing without fully disconnecting it" — the eligibility query
      // itself lives on ConnectorsService (listEligibleForIncrementalScan) so it's unit-testable without a
      // live worker; this tick just enqueues one incremental sync per connection it returns.
      const eligible = await connectors.listEligibleForIncrementalScan();
      for (const connection of eligible) {
        await queueProducer.enqueueConnectorSync({ connectionId: connection.id, kind: "incremental" });
      }
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

      // Voice notes store their raw audio at sourceEvents.rawContentRef, not in documentVersions — same
      // "collect blob refs before the cascading delete removes the rows that reference them" reasoning as
      // the query just above. Found live: account deletion previously only ever looked at documentVersions,
      // so a voice-note recording would have been orphaned in S3 forever once its owning account was deleted.
      const voiceNoteBlobs = await db
        .select({ blobRef: schema.sourceEvents.rawContentRef })
        .from(schema.sourceEvents)
        .where(and(eq(schema.sourceEvents.ownerUserId, userId), eq(schema.sourceEvents.kind, "voice_note")));

      // Households with no other active member cascade away entirely once deleted (memberships,
      // dependents, etc. all reference households.id with onDelete: "cascade"). Must happen before the
      // user row is deleted — billingOwnerUserId has no onDelete action, so it would otherwise block it.
      for (const id of soloHouseholdIds) {
        await db.delete(schema.households).where(eq(schema.households.id, id));
      }
      await db.delete(schema.users).where(eq(schema.users.id, userId));

      // Not itself a FK to users.id (actorId is a bare string column) — survives the delete above by design.
      await db.insert(schema.auditEvents).values({
        id: generateId("auditEvent"),
        actorType: "system",
        actorId: userId,
        action: "account_deletion",
        resourceType: "user",
        resourceId: userId,
        result: "success",
      });

      for (const { blobRef } of blobs) {
        try {
          await storage.deleteObject(blobRef);
        } catch (err) {
          logger.error(`Failed to delete S3 object ${blobRef} for deleted user ${userId}: ${String((err as Error)?.message ?? err)}`);
        }
      }
      for (const { blobRef } of voiceNoteBlobs) {
        if (!blobRef) continue; // a non-voice-note sourceEvent kind should never appear here given the query's own filter, but rawContentRef is nullable on the column itself
        try {
          await storage.deleteObject(blobRef);
        } catch (err) {
          logger.error(`Failed to delete voice-note S3 object ${blobRef} for deleted user ${userId}: ${String((err as Error)?.message ?? err)}`);
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
      // MAIL-008 audit fix: store credits were the one extractor-produced domain object this worker never
      // purged — extractStoreCredit (ingestion.service.ts) writes a real sourceEventId onto storeCredits
      // exactly like bills/warranties do, but nothing here ever deleted it, so "Disconnect & delete data"
      // silently left store-credit rows (and their attention items) behind for this connection.
      const storeCreditIds = idsFor("store_credit");
      if (billIds.length > 0) await db.delete(schema.bills).where(inArray(schema.bills.id, billIds));
      if (warrantyIds.length > 0) await db.delete(schema.warranties).where(inArray(schema.warranties.id, warrantyIds));
      if (calendarEventIds.length > 0) await db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, calendarEventIds));
      if (shipmentIds.length > 0) await db.delete(schema.shipments).where(inArray(schema.shipments.id, shipmentIds));
      if (storeCreditIds.length > 0) await db.delete(schema.storeCredits).where(inArray(schema.storeCredits.id, storeCreditIds));

      const allLinkedIds = [...purchaseIds, ...billIds, ...warrantyIds, ...calendarEventIds, ...shipmentIds, ...storeCreditIds];
      if (allLinkedIds.length > 0) await db.delete(schema.attentionItems).where(inArray(schema.attentionItems.linkedResourceId, allLinkedIds));

      await db.delete(schema.inboxItems).where(inArray(schema.inboxItems.sourceEventId, sourceEventIds));
      await db.delete(schema.sourceEvents).where(inArray(schema.sourceEvents.id, sourceEventIds));

      await db.insert(schema.auditEvents).values({
        id: generateId("auditEvent"),
        actorType: "user",
        actorId: ownerUserId,
        action: "connection.delete_derived_data",
        resourceType: "connection",
        resourceId: connectionId,
        beforeJson: { sourceEventCount: sourceEventIds.length, purchaseCount: purchaseIds.length },
        result: "success",
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
      // FIN-004 "duplicate/unusual charge assistance" — rides the same hourly tick as the deadline scan
      // above rather than getting its own queue/repeat schedule; both are the same shape of work (a
      // system-wide sweep that files attention items via fileIfNew's dedup).
      await finance.detectAnomalousTransactions();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** PRIV-002 — gathers the user's full manifest (DataExportService.buildManifest), uploads it as a single JSON object, and marks the job completed/failed accordingly. */
  const dataExportWorker = new Worker<DataExportJobData>(
    QUEUE_NAMES.dataExport,
    async (job) => {
      const { exportJobId, userId, selectedCategories } = job.data;
      await db.update(schema.exportJobs).set({ state: "processing" }).where(eq(schema.exportJobs.id, exportJobId));
      try {
        const manifest = await dataExport.buildManifest(userId, selectedCategories);
        const storageKey = dataExport.storageKeyFor(userId, exportJobId);
        const serialized = Buffer.from(JSON.stringify(manifest, null, 2));
        await storage.putObject(storageKey, serialized, "application/json");
        // PRIV-002 "size/progress" — computed on the exact manifest/buffer that was just serialized and
        // uploaded, so these numbers are always consistent with the file a download actually returns.
        await db
          .update(schema.exportJobs)
          .set({
            state: "completed",
            storageKey,
            completedAt: new Date(),
            expiresAt: new Date(Date.now() + dataExport.ttlMs()),
            itemCount: dataExport.itemCountOf(manifest),
            estimatedSizeBytes: serialized.byteLength,
          })
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

  /** §11 — the actual AI classification/extraction work the inbound-email webhook handler used to do
   * inline; see queue-names.ts's InboundEmailIngestJobData doc comment and inbound-email.controller.ts. */
  const inboundEmailIngestWorker = new Worker<InboundEmailIngestJobData>(
    QUEUE_NAMES.inboundEmailIngest,
    async (job) => {
      await ingestion.ingestManualText({ ...job.data, kind: "inbound_email" });
    },
    { connection: getRedisConnection(), concurrency: 3 },
  );

  /** §28.13 "excessive OCR work" — see queue-names.ts's DocumentOcrJobData doc comment for why PDF/image
   * transcription moved off the synchronous upload request into this worker. */
  const documentOcrWorker = new Worker<DocumentOcrJobData>(
    QUEUE_NAMES.documentOcr,
    async (job) => {
      await documents.processOcr(job.data);
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  /** §52.1 "voice note" transcription — see queue-names.ts's VoiceTranscriptionJobData doc comment for why
   * this moved off the synchronous upload request, mirroring documentOcrWorker's identical shape. */
  const voiceTranscriptionWorker = new Worker<VoiceTranscriptionJobData>(
    QUEUE_NAMES.voiceTranscription,
    async (job) => {
      await ingestion.processVoiceTranscription(job.data);
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  /** §25 SCH-002 — one school/team ICS feed's sync (SchoolIcsService.sync). */
  const schoolSourceSyncWorker = new Worker<SchoolSourceSyncJobData>(
    QUEUE_NAMES.schoolSourceSync,
    async (job) => {
      await schoolIcs.sync(job.data.schoolSourceId);
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  // Recurring tick (see QueueProducerService.scheduleRecurringSchoolSourceScan): finds every still-
  // subscribed ("ics" kind, not disconnected) school_sources row and enqueues a sync for each — mirrors
  // connectorScanWorker's identical shape, deduplicated by enqueueSchoolSourceSync's jobId so a source
  // already mid-sync when this tick fires is just skipped rather than double-queued.
  const schoolSourceScanWorker = new Worker<SchoolSourceScanJobData>(
    QUEUE_NAMES.schoolSourceScan,
    async () => {
      const eligible = await db
        .select({ id: schema.schoolSources.id })
        .from(schema.schoolSources)
        .where(and(eq(schema.schoolSources.kind, "ics"), isNull(schema.schoolSources.disconnectedAt)));
      for (const source of eligible) {
        await queueProducer.enqueueSchoolSourceSync({ schoolSourceId: source.id });
      }
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** VEH-006/HOMEOS-008 — one vehicle or home asset's recall check (RecallMonitorService.checkVehicle/
   * checkHomeAsset), off the request that created it — see queue-names.ts's RecallCheckJobData doc
   * comment. */
  const recallCheckWorker = new Worker<RecallCheckJobData>(
    QUEUE_NAMES.recallCheck,
    async (job) => {
      const { subjectType, subjectId } = job.data;
      if (subjectType === "vehicle") {
        await recallMonitor.checkVehicle(subjectId);
      } else {
        await recallMonitor.checkHomeAsset(subjectId);
      }
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  // Recurring tick (see QueueProducerService.scheduleRecurringRecallScan): re-checks every checkable
  // vehicle/home asset against NHTSA/CPSC — mirrors attentionScanWorker's identical shape (a single
  // no-payload processor that does its own lookup).
  const recallScanWorker = new Worker<RecallScanJobData>(
    QUEUE_NAMES.recallScan,
    async () => {
      await recallMonitor.scanAll();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** §35 SHARE-005 "automatically expires" — see queue-names.ts's CaregiverDayPassScanJobData doc comment
   * / CaregiverDayPassService.expireDuePasses's own doc comment for why this is UI/audit-trail accuracy,
   * not the actual access control (the redemption path re-checks expiresAt live regardless). */
  const caregiverDayPassScanWorker = new Worker<CaregiverDayPassScanJobData>(
    QUEUE_NAMES.caregiverDayPassScan,
    async () => {
      await caregiverDayPasses.expireDuePasses();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** §35 SHARE-006 legacy-release inactivity trigger — see queue-names.ts's
   * LegacyReleaseInactivityScanJobData doc comment / LegacyReleaseService.scanInactivity's own doc comment
   * for what a tick does (the earlier "still there?" warning, and the auto-initiated waiting period once
   * the owner's own configured inactivity threshold is fully crossed). Mirrors recallScanWorker's identical
   * shape. */
  const legacyReleaseInactivityScanWorker = new Worker<LegacyReleaseInactivityScanJobData>(
    QUEUE_NAMES.legacyReleaseInactivityScan,
    async () => {
      await legacyRelease.scanInactivity();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** §Operations "data-integrity/orphan-check job" — see queue-names.ts's DataIntegrityScanJobData doc
   * comment and DataIntegrityService.scanForOrphans for what a tick does. Log-only by design: it reports
   * dangling cross-table links rather than auto-deleting them. */
  const dataIntegrityScanWorker = new Worker<DataIntegrityScanJobData>(
    QUEUE_NAMES.dataIntegrityScan,
    async () => {
      await dataIntegrity.scanForOrphans();
    },
    { connection: getRedisConnection(), concurrency: 1 },
  );

  /** §29.1 SAVE-001/002 — see queue-names.ts's MemoryClassificationJobData doc comment for why this moved
   * off the synchronous save request. */
  const memoryClassificationWorker = new Worker<MemoryClassificationJobData>(
    QUEUE_NAMES.memoryClassification,
    async (job) => {
      await memories.processClassification(job.data.savedMemoryId);
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  /** §29.1 SAVE-004 — ResurfacingService.scanAndFileResurfacing's recurring tick. Concurrency 1: see that
   * method's own doc comment on why its rule-recurrence guard depends on ticks never overlapping. */
  const resurfacingScanWorker = new Worker<ResurfacingScanJobData>(
    QUEUE_NAMES.resurfacingScan,
    async () => {
      await resurfacing.scanAndFileResurfacing();
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
    inboundEmailIngestWorker,
    documentOcrWorker,
    voiceTranscriptionWorker,
    schoolSourceSyncWorker,
    schoolSourceScanWorker,
    recallCheckWorker,
    recallScanWorker,
    caregiverDayPassScanWorker,
    legacyReleaseInactivityScanWorker,
    dataIntegrityScanWorker,
    memoryClassificationWorker,
    resurfacingScanWorker,
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
  await queueProducer.scheduleRecurringSchoolSourceScan();
  await queueProducer.scheduleRecurringRecallScan();
  await queueProducer.scheduleRecurringResurfacingScan();
  await queueProducer.scheduleRecurringCaregiverDayPassScan();
  await queueProducer.scheduleRecurringLegacyReleaseInactivityScan();
  await queueProducer.scheduleRecurringDataIntegrityScan();

  logger.log(
    "Veynlo worker process started — processing connector-sync, connector-scan, notification-dispatch, notification-delivery, account-deletion, connection-data-deletion, inbox-unsnooze, attention-scan, data-export, inbound-email-ingest, document-ocr, voice-transcription, school-source-sync, school-source-scan, recall-check, recall-scan, caregiver-day-pass-scan, legacy-release-inactivity-scan, memory-classification, resurfacing-scan",
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
      inboundEmailIngestWorker.close(),
      documentOcrWorker.close(),
      voiceTranscriptionWorker.close(),
      schoolSourceSyncWorker.close(),
      schoolSourceScanWorker.close(),
      recallCheckWorker.close(),
      recallScanWorker.close(),
      caregiverDayPassScanWorker.close(),
      legacyReleaseInactivityScanWorker.close(),
      dataIntegrityScanWorker.close(),
      memoryClassificationWorker.close(),
      resurfacingScanWorker.close(),
    ]);
    await appContext.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

bootstrap();
