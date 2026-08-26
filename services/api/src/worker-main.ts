import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { Worker } from "bullmq";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@veynlo/db";
import { AppModule } from "./app.module";
import { DATABASE } from "./database/database.module";
import { getRedisConnection } from "./queue/redis-connection";
import {
  QUEUE_NAMES,
  type ConnectorScanJobData,
  type ConnectorSyncJobData,
  type NotificationDeliveryJobData,
  type NotificationDispatchJobData,
} from "./queue/queue-names";
import { GmailAdapter } from "./modules/connectors/gmail.adapter";
import { OutlookAdapter } from "./modules/connectors/outlook.adapter";
import { NotificationDeliveryService } from "./modules/notifications/notification-delivery.service";
import { NotificationDispatchService } from "./modules/notifications/notification-dispatch.service";
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

  for (const worker of [connectorSyncWorker, connectorScanWorker, notificationDispatchWorker, notificationDeliveryWorker]) {
    worker.on("failed", (job, err) => logger.error(`Job ${job?.queueName}/${job?.id} failed: ${err.message}`));
    worker.on("completed", (job) => logger.log(`Job ${job.queueName}/${job.id} completed`));
  }

  // Registers the repeatable daily/weekly brief jobs and the connector incremental-scan tick
  // (idempotent — BullMQ dedupes repeat jobs by jobId).
  await queueProducer.scheduleRecurringNotificationDispatch();
  await queueProducer.scheduleRecurringConnectorScan();

  logger.log(
    "Veynlo worker process started — processing connector-sync, connector-scan, notification-dispatch, notification-delivery",
  );

  const shutdown = async () => {
    logger.log("Shutting down worker process...");
    await Promise.all([
      connectorSyncWorker.close(),
      connectorScanWorker.close(),
      notificationDispatchWorker.close(),
      notificationDeliveryWorker.close(),
    ]);
    await appContext.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

bootstrap();
