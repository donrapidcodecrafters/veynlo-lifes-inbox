/**
 * §42.5 — durable workflows vs. short retryable jobs. These are the queues
 * that make connector sync and notification delivery survive a process
 * restart instead of running inline on the HTTP request that triggered them.
 */
export const QUEUE_NAMES = {
  connectorSync: "connector-sync",
  notificationDispatch: "notification-dispatch",
  notificationDelivery: "notification-delivery",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface ConnectorSyncJobData {
  connectionId: string;
  kind: "initial" | "incremental";
}

export interface NotificationDispatchJobData {
  /** Which recurring brief this tick is composing. */
  brief: "daily" | "weekly";
}

export interface NotificationDeliveryJobData {
  notificationId: string;
}
