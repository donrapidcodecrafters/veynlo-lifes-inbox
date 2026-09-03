import type {
  ConnectorSyncJobData,
  NotificationDeliveryJobData,
  AccountDeletionJobData,
  ConnectionDataDeletionJobData,
  DataExportJobData,
  InboundEmailIngestJobData,
  DocumentOcrJobData,
  VoiceTranscriptionJobData,
  MemoryClassificationJobData,
  SchoolSourceSyncJobData,
  RecallCheckJobData,
} from "./queue-names";

/**
 * §37 "Create Queue... interfaces so local mocks can be replaced by AWS/provider implementations" — the
 * public contract every consumer in the app actually depends on. `QueueProducerService` is the only
 * implementation today (BullMQ/Redis); a future `SqsQueueProducerService` would implement this same
 * interface, and nothing outside `queue.module.ts` would need to change. Deliberately domain-specific
 * methods (`enqueueAccountDeletion`, not a generic `enqueue(queueName, data)`) rather than a thin wrapper
 * around BullMQ's own `Queue.add` — a generic signature would just move the job-shape/id/retry-policy
 * knowledge out to every call site instead of keeping it here, which is the opposite of what an interface
 * boundary is for.
 */
export interface QueueProducer {
  enqueueConnectorSync(data: ConnectorSyncJobData): Promise<void>;
  scheduleRecurringConnectorScan(): Promise<void>;
  scheduleRecurringNotificationDispatch(): Promise<void>;
  scheduleRecurringInboxUnsnooze(): Promise<void>;
  scheduleRecurringAttentionScan(): Promise<void>;
  enqueueConnectionDataDeletion(data: ConnectionDataDeletionJobData): Promise<void>;
  enqueueNotificationDelivery(data: NotificationDeliveryJobData, delayMs?: number): Promise<void>;
  enqueueAccountDeletion(data: AccountDeletionJobData, delayMs?: number): Promise<void>;
  /** PRIV-002 grace period — pulls a still-delayed account-deletion job back before it fires. See
   * queue-producer.service.ts's implementation doc comment for what happens if it's already running. */
  cancelAccountDeletion(userId: string): Promise<void>;
  enqueueDataExport(data: DataExportJobData): Promise<void>;
  enqueueInboundEmailIngest(data: InboundEmailIngestJobData): Promise<void>;
  enqueueDocumentOcr(data: DocumentOcrJobData): Promise<void>;
  enqueueVoiceTranscription(data: VoiceTranscriptionJobData): Promise<void>;
  enqueueMemoryClassification(data: MemoryClassificationJobData): Promise<void>;
  scheduleRecurringResurfacingScan(): Promise<void>;
  enqueueSchoolSourceSync(data: SchoolSourceSyncJobData): Promise<void>;
  scheduleRecurringSchoolSourceScan(): Promise<void>;
  enqueueRecallCheck(data: RecallCheckJobData): Promise<void>;
  scheduleRecurringRecallScan(): Promise<void>;
  /** §35 SHARE-005 "automatically expires" — see queue-names.ts's CaregiverDayPassScanJobData doc comment. */
  scheduleRecurringCaregiverDayPassScan(): Promise<void>;
  /** §35 SHARE-006 legacy-release inactivity trigger — see queue-names.ts's LegacyReleaseInactivityScanJobData doc comment. */
  scheduleRecurringLegacyReleaseInactivityScan(): Promise<void>;
  getQueueHealth(): Promise<Record<string, { waiting: number; active: number; delayed: number; completed: number; failed: number }>>;
}

/** TypeScript interfaces have no runtime representation, so NestJS's reflection-based DI needs an
 * explicit token to inject by. `useExisting` in queue.module.ts points this at the same singleton
 * `QueueProducerService` instance the concrete class token also resolves to — worker-main.ts's existing
 * `appContext.get(QueueProducerService)` keeps working unchanged. */
export const QUEUE_PRODUCER = Symbol("QUEUE_PRODUCER");
