import { z } from "zod";

/**
 * §42.3-42.4 — domain event taxonomy. Events describe something that
 * happened; commands (see connectors/types.ts `providerAction`) request
 * something to happen. Never overload one type for both.
 */
export const DomainEventTypeSchema = z.enum([
  // Source / ingestion
  "SourceReceived.v1",
  "SourceUpdated.v1",
  "SourceDeleted.v1",
  "FileUploaded.v1",
  "DocumentProcessed.v1",
  "SyncCheckpointAdvanced.v1",
  // Facts / entities
  "FactExtracted.v1",
  "FactVerified.v1",
  "FactCorrected.v1",
  "FactSuperseded.v1",
  "ConflictDetected.v1",
  "EntityCreated.v1",
  "EntityMerged.v1",
  "EntityUnmerged.v1",
  "RelationshipChanged.v1",
  // Attention
  "InboxItemCreated.v1",
  "InboxItemResolved.v1",
  "AttentionCandidateCreated.v1",
  "AttentionItemChanged.v1",
  "BriefReady.v1",
  // Commerce
  "PurchaseDetected.v1",
  "PurchaseUpdated.v1",
  "ReturnWindowChanged.v1",
  "ReturnStarted.v1",
  "RefundExpected.v1",
  "RefundObserved.v1",
  "ShipmentStatusChanged.v1",
  // Recurring money
  "SubscriptionDetected.v1",
  "SubscriptionStatusChanged.v1",
  "RecurringAmountChanged.v1",
  "BillDueChanged.v1",
  "PaymentObserved.v1",
  // Calendar / tasks
  "EventCreated.v1",
  "EventChanged.v1",
  "EventCanceled.v1",
  "TaskCreated.v1",
  "TaskCompleted.v1",
  // Life domains
  "CredentialExpiring.v1",
  "MaintenanceDueChanged.v1",
  "RecallMatched.v1",
  "TripCreated.v1",
  "ReservationChanged.v1",
  "SchoolItemChanged.v1",
  "PetCareDue.v1",
  // Sharing / household
  "MemberJoined.v1",
  "MemberLeft.v1",
  "ShareGranted.v1",
  "ShareRevoked.v1",
  "AssignmentChanged.v1",
  // Automation
  "AutomationTriggered.v1",
  "ApprovalRequested.v1",
  "ApprovalGranted.v1",
  "CommandStarted.v1",
  "CommandSucceeded.v1",
  "CommandFailed.v1",
  "CompensationCompleted.v1",
  // Operations
  "ConnectionHealthChanged.v1",
  "EntitlementChanged.v1",
  "ExportReady.v1",
  "DeletionRequested.v1",
  "SecurityEventRaised.v1",
]);
export type DomainEventType = z.infer<typeof DomainEventTypeSchema>;

export const DomainEventEnvelopeSchema = z.object({
  eventId: z.string(),
  type: DomainEventTypeSchema,
  occurredAt: z.string().datetime(),
  recordedAt: z.string().datetime(),
  actor: z.object({ type: z.enum(["user", "system", "service"]), id: z.string().nullable() }),
  ownerUserId: z.string(),
  householdId: z.string().nullable(),
  aggregateType: z.string(),
  aggregateId: z.string(),
  correlationId: z.string(),
  causationId: z.string().nullable(),
  sensitivity: z.enum(["standard", "sensitive", "highly_sensitive", "secret"]),
  payload: z.record(z.string(), z.unknown()),
});
export type DomainEventEnvelope = z.infer<typeof DomainEventEnvelopeSchema>;
