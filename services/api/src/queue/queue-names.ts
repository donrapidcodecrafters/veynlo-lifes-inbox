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
  inboxUnsnooze: "inbox-unsnooze",
  attentionScan: "attention-scan",
  connectionDataDeletion: "connection-data-deletion",
  dataExport: "data-export",
  inboundEmailIngest: "inbound-email-ingest",
  documentOcr: "document-ocr",
  voiceTranscription: "voice-transcription",
  memoryClassification: "memory-classification",
  resurfacingScan: "resurfacing-scan",
  schoolSourceSync: "school-source-sync",
  schoolSourceScan: "school-source-scan",
  recallCheck: "recall-check",
  recallScan: "recall-scan",
  caregiverDayPassScan: "caregiver-day-pass-scan",
  legacyReleaseInactivityScan: "legacy-release-inactivity-scan",
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

/** Recurring tick with no payload — its processor finds due snoozed items itself (see worker-main.ts). */
export type InboxUnsnoozeScanJobData = Record<string, never>;

/** Recurring tick with no payload — its processor (AttentionService.scanAndFileDeadlines) finds upcoming bill/return/warranty deadlines itself. */
export type AttentionScanJobData = Record<string, never>;

export interface ConnectionDataDeletionJobData {
  connectionId: string;
  ownerUserId: string;
}

export interface DataExportJobData {
  exportJobId: string;
  userId: string;
  /** PRIV-002 "category selection" — undefined/null means "export everything" (today's behavior,
   * unchanged for every caller that doesn't pass this). See DataExportService.buildManifest for the
   * recognized keys. */
  selectedCategories?: string[] | null;
}

/**
 * §11 "Never call large AI models synchronously from webhook handlers" — the inbound-email webhook
 * (InboundEmailController) used to call IngestionService.ingestManualText, AI classification/extraction
 * included, directly inside the HTTP handler. This job carries exactly what that method needs so the
 * webhook can insert the source_event (fast, no AI) and enqueue this instead of doing the AI work inline
 * — see worker-main.ts's inboundEmailIngestWorker.
 */
export interface InboundEmailIngestJobData {
  ownerUserId: string;
  householdId: string | null;
  subject: string;
  bodyText: string;
  fromAddress?: string;
}

/**
 * §28.13 "Run high-risk document parsing in a dedicated ... worker role ... with strict CPU/memory/time
 * limits" — OCR (a full PDF/image sent to an external AI vision API) used to run inline inside the upload
 * HTTP request, meaning a slow/large document tied up an API request thread and had no bounded retry
 * behavior distinct from a plain client timeout. This carries just enough to re-fetch and process the
 * already-stored file — not the file bytes themselves, which stay in object storage (see worker-main.ts's
 * documentOcrWorker).
 */
export interface DocumentOcrJobData {
  documentId: string;
  versionId: string;
  blobKey: string;
  mimeType: string;
}

/**
 * §52.1 Capture "voice note" transcription — same off-request shape as DocumentOcrJobData above: local
 * Whisper inference (WhisperVoiceTranscriptionService) is real CPU work with no bounded latency guarantee,
 * so it runs in the background worker rather than tying up the upload request the way DocumentOcrJobData's
 * doc comment already argues for OCR. Carries just enough to re-fetch the already-stored audio blob and
 * the owner/household needed to feed a resulting transcript into `IngestionService.classifyAndExtract` —
 * not the audio bytes themselves, which stay in object storage.
 */
export interface VoiceTranscriptionJobData {
  sourceEventId: string;
  ownerUserId: string;
  householdId: string | null;
  blobKey: string;
  mimeType: string;
}

/**
 * §29.1 SAVE-001 "Immediate success confirmation; structure may appear seconds later" — same off-request
 * pattern as DocumentOcrJobData above: MemoriesService.create() persists the save synchronously and returns
 * right away, and this job carries just the id needed to re-fetch and classify it in the background (see
 * worker-main.ts's memoryClassificationWorker / MemoriesService.processClassification).
 */
export interface MemoryClassificationJobData {
  savedMemoryId: string;
}

/** Recurring tick with no payload — its processor (ResurfacingService.scanAndFileResurfacing) finds due
 * date/birthday resurfacing rules itself, mirroring AttentionScanJobData's identical shape. */
export type ResurfacingScanJobData = Record<string, never>;

/** §25 SCH-002 — one school/team ICS feed's sync, mirroring ConnectorSyncJobData's shape without the
 * "initial vs incremental" distinction (SchoolIcsService.sync is always a full refetch, deduped by each
 * VEVENT's own UID — see its own doc comment, same reasoning as IcsAdapter's identical choice). */
export interface SchoolSourceSyncJobData {
  schoolSourceId: string;
}

/** Recurring tick with no payload — its processor finds eligible (still-subscribed) school_sources itself, mirroring ConnectorScanJobData's identical shape. */
export type SchoolSourceScanJobData = Record<string, never>;

/**
 * VEH-006/HOMEOS-008 — one vehicle or home asset's recall check against NHTSA/CPSC, off the request that
 * created/asked for it, mirroring MemoryClassificationJobData's identical "persist synchronously, classify
 * in the background" shape: AssetsService.createVehicle/createHomeAsset return immediately after the
 * insert, and this job carries just the subject id needed to re-fetch and check it (see worker-main.ts's
 * recallCheckWorker / RecallMonitorService.checkVehicle/checkHomeAsset).
 */
export interface RecallCheckJobData {
  subjectType: "vehicle" | "home_asset";
  subjectId: string;
}

/** Recurring tick with no payload — its processor (RecallMonitorService.scanAll) finds every checkable
 * vehicle/home asset itself, mirroring AttentionScanJobData's identical shape. Daily rather than
 * attention-scan's hourly cadence — recall data doesn't change minute-to-minute, and this makes one
 * outbound NHTSA/CPSC HTTP call per vehicle/home asset on every tick, so there's no value polling more
 * often, just more external-API load. */
export type RecallScanJobData = Record<string, never>;

/** §35 SHARE-005 "automatically expires" — recurring tick with no payload, mirroring
 * InboxUnsnoozeScanJobData's identical shape: its processor (CaregiverDayPassService.expireDuePasses)
 * finds every pass whose `expiresAt` has passed and stamps `expiredAt`. 15-minute cadence, same as
 * inbox-unsnooze — a day pass is measured in hours, so "expired but still shown as active" for up to an
 * hour (attention-scan's cadence) would be a noticeably stale household-facing list. */
export type CaregiverDayPassScanJobData = Record<string, never>;

/** §35 SHARE-006 legacy-release inactivity trigger — recurring tick with no payload, mirroring
 * RecallScanJobData's identical shape: its processor (LegacyReleaseService.scanInactivity) finds every
 * armed config with an owner-configured `inactivityThresholdDays` and checks it against real
 * `users.lastActiveAt`. Daily, not attention-scan's hourly cadence — inactivity thresholds are measured in
 * days, so there's no value polling more often, just more load; see LegacyReleaseService.scanInactivity's
 * own doc comment for what a tick actually does (the earlier "still there?" warning, and the auto-initiated
 * waiting period once the full threshold is crossed). */
export type LegacyReleaseInactivityScanJobData = Record<string, never>;
