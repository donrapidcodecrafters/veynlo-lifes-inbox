import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Worker } from "bullmq";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
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
  type NotificationDeliveryJobData,
  type NotificationDispatchJobData,
} from "./queue/queue-names";
import { GmailAdapter } from "./modules/connectors/gmail.adapter";
import { OutlookAdapter } from "./modules/connectors/outlook.adapter";
import { NotificationDeliveryService } from "./modules/notifications/notification-delivery.service";
import { NotificationDispatchService } from "./modules/notifications/notification-dispatch.service";
import { StorageService } from "./modules/documents/storage.service";
import { QueueProducerService } from "./queue/queue-producer.service";

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
  const appContext = await NestFactory.createApplicationContext(AppModule, { logger: ["error", "warn", "log"] });

  const db = appContext.get<Database>(DATABASE);
  const gmailAdapter = appContext.get(GmailAdapter);
  const outlookAdapter = appContext.get(OutlookAdapter);
  const notificationDelivery = appContext.get(NotificationDeliveryService);
  const notificationDispatch = appContext.get(NotificationDispatchService);
  const storage = appContext.get(StorageService);
  const queueProducer = appContext.get(QueueProducerService);

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
        const adapter = connection.provider === "outlook" ? outlookAdapter : gmailAdapter;
        if (kind === "incremental") {
          await adapter.incrementalSync(connectionId);
        } else {
          await adapter.initialSync(connectionId);
        }
      } catch (err) {
        await db
          .update(schema.connections)
          .set({ health: "degraded", healthDetail: String((err as Error)?.message ?? err) })
          .where(eq(schema.connections.id, connectionId));
        throw err; // let BullMQ's retry/backoff attempt again before giving up
      }
    },
    { connection: getRedisConnection(), concurrency: 4 },
  );

  // Recurring tick (see QueueProducerService.scheduleRecurringConnectorScan): finds every healthy,
  // still-connected direct-API email connection (Gmail, Outlook) and enqueues one incremental sync per
  // connection. Deduplicated by enqueueConnectorSync's jobId (`${connectionId}-incremental`), so a
  // connection already mid-sync when this tick fires is just skipped rather than double-queued.
  const connectorScanWorker = new Worker<ConnectorScanJobData>(
    QUEUE_NAMES.connectorScan,
    async () => {
      const eligible = await db
        .select({ id: schema.connections.id })
        .from(schema.connections)
        .where(
          and(
            inArray(schema.connections.provider, ["gmail", "outlook"]),
            eq(schema.connections.health, "healthy"),
            isNull(schema.connections.disconnectedAt),
          ),
        );
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
    },
    { connection: getRedisConnection(), concurrency: 2 },
  );

  for (const worker of [
    connectorSyncWorker,
    connectorScanWorker,
    notificationDispatchWorker,
    notificationDeliveryWorker,
    accountDeletionWorker,
  ]) {
    worker.on("failed", (job, err) => logger.error(`Job ${job?.queueName}/${job?.id} failed: ${err.message}`));
    worker.on("completed", (job) => logger.log(`Job ${job.queueName}/${job.id} completed`));
  }

  // Registers the repeatable daily/weekly brief jobs and the connector incremental-scan tick
  // (idempotent — BullMQ dedupes repeat jobs by jobId).
  await queueProducer.scheduleRecurringNotificationDispatch();
  await queueProducer.scheduleRecurringConnectorScan();

  logger.log(
    "Veynlo worker process started — processing connector-sync, connector-scan, notification-dispatch, notification-delivery, account-deletion",
  );

  const shutdown = async () => {
    logger.log("Shutting down worker process...");
    await Promise.all([
      connectorSyncWorker.close(),
      connectorScanWorker.close(),
      notificationDispatchWorker.close(),
      notificationDeliveryWorker.close(),
      accountDeletionWorker.close(),
    ]);
    await appContext.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

bootstrap();
