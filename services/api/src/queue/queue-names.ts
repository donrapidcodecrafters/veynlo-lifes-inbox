/**
 * §42.5 — durable workflows vs. short retryable jobs. These are the queues
 * that make connector sync and notification delivery survive a process
 * restart instead of running inline on the HTTP request that triggered them.
 */
export const QUEUE_NAMES = {
  connectorSync: "connector-sync",
  connectorScan: "connector-scan",
  notificationDispatch: "notification-dispatch",
  notificationDelivery: "notification-delivery",
  accountDeletion: "account-deletion",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ConnectorSyncJobData {
  connectionId: string;
  kind: "initial" | "incremental";
}

/** Recurring tick with no payload — its processor finds eligible connections itself (see worker-main.ts). */
export type ConnectorScanJobData = Record<string, never>;

export interface NotificationDispatchJobData {
  /** Which recurring brief this tick is composing. */
  brief: "daily" | "weekly";
}

export interface NotificationDeliveryJobData {
  notificationId: string;
}

export interface AccountDeletionJobData {
  userId: string;
}
