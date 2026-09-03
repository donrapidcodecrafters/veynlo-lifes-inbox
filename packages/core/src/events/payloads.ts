import type { SensitivityTier } from "../permissions/sensitivity";
import type { ConfidenceBand } from "../entities/provenance";
import type { DomainEventEnvelope, DomainEventType } from "./taxonomy";

/**
 * §42.3/42.4 — typed payload shapes for the domain-event taxonomy, layered on top of
 * `DomainEventEnvelopeSchema`'s intentionally-loose `z.record(...)` payload (a zod schema can't express a
 * discriminated union keyed by a sibling field's value without a lot of `z.discriminatedUnion` boilerplate
 * duplicated per event, and the wire/runtime validation job that schema already does — "is this a
 * structurally valid envelope" — doesn't need per-event payload precision to do its job). This file adds
 * the compile-time precision on top: `DomainEvent` below is a real discriminated union on `type`, so a
 * consumer's `if (event.type === "PurchaseDetected.v1")` narrows `event.payload` to
 * `PurchaseDetectedPayload` with no cast.
 *
 * Only the event types this round's real emitters (`IngestionService`, `AttentionService`) and the real
 * consumer (`DomainEventAuditListener`) actually produce/need get a hand-written payload interface below.
 * Every other event in the §42.3 taxonomy still gets a real (if generic) `Record<string, unknown>` payload
 * slot in the union via `DomainEventPayloadMap`'s mapped-type fallback — the taxonomy is fully covered, so
 * adding a real payload for e.g. `RecallMatched.v1` later is additive (one new interface + one new map
 * entry), never a breaking change to the envelope or the emitter API. This mirrors §42.4's own "old
 * consumers can ignore additive fields" schema-compatibility stance.
 */

export interface FactExtractedPayload {
  factId: string;
  /** e.g. "purchase_details" — matches `facts.predicate` verbatim, not a separate taxonomy. */
  predicate: string;
  subjectEntityType: string;
  subjectEntityId: string;
  extractionMethod: string;
  extractorVersion: string;
  confidenceScore: number;
  confidenceBand: ConfidenceBand;
  sourceEventId: string | null;
  evidenceIds: string[];
}

export interface PurchaseDetectedPayload {
  purchaseId: string;
  merchantId: string | null;
  merchantLabel: string;
  orderNumber: string | null;
  totalMinorUnits: number | null;
  currency: string | null;
  confidenceBand: ConfidenceBand;
  sourceEventId: string;
}

export interface PurchaseUpdatedPayload {
  purchaseId: string;
  merchantId: string | null;
  merchantLabel: string;
  orderNumber: string | null;
  totalMinorUnits: number | null;
  currency: string | null;
  sourceEventId: string;
}

export interface SubscriptionDetectedPayload {
  subscriptionId: string;
  recurringStreamId: string;
  merchantLabel: string;
  cadence: string;
  state: string;
  typicalAmountMinorUnits: number | null;
  currency: string | null;
  sourceEventId: string;
}

export interface SubscriptionStatusChangedPayload {
  subscriptionId: string;
  recurringStreamId: string;
  merchantLabel: string;
  previousState: string;
  state: string;
  sourceEventId: string;
}

export interface BillDueChangedPayload {
  billId: string;
  billerLabel: string;
  billerCategory: string | null;
  dueDateIso: string | null;
  amountDueMinorUnits: number | null;
  amountDueCurrency: string | null;
  confidenceBand: ConfidenceBand;
  sourceEventId: string;
}

/**
 * Closest §42.3-named event to "an attention item was filed" — the taxonomy has no literal
 * `AttentionItemFiled`; `AttentionCandidateCreated.v1` is the named Attention-family event for a new
 * needs-you queue row (`AttentionItemChanged.v1` covers the escalation-in-place case instead — see
 * `AttentionService.insertAttentionItem`'s own doc comment for why both paths converge on one emit site).
 */
export interface AttentionCandidateCreatedPayload {
  attentionItemId: string;
  reasonCode: string;
  urgency: "critical" | "important" | "useful";
  /** `ScannedAttentionItem.confidenceBand` (attention.service.ts) is a plain `string`, not the stricter
   * `ConfidenceBand` enum the ingestion-side payloads above use — attention items are filed from several
   * different domains (bills/warranties/pets/etc.), not all of which route through `confidenceToBand`. */
  confidenceBand: string;
  linkedResourceType: string;
  linkedResourceId: string;
  moneyAtStakeMinorUnits: number | null;
  moneyAtStakeCurrency: string | null;
  dueAtIso: string | null;
}

interface DomainEventPayloadOverrides {
  "FactExtracted.v1": FactExtractedPayload;
  "PurchaseDetected.v1": PurchaseDetectedPayload;
  "PurchaseUpdated.v1": PurchaseUpdatedPayload;
  "SubscriptionDetected.v1": SubscriptionDetectedPayload;
  "SubscriptionStatusChanged.v1": SubscriptionStatusChangedPayload;
  "BillDueChanged.v1": BillDueChangedPayload;
  "AttentionCandidateCreated.v1": AttentionCandidateCreatedPayload;
}

/** Every §42.3 event type maps to a real payload shape — a hand-written one above where a real emitter
 * already exists, `Record<string, unknown>` (still a real, typed-as-JSON-object payload, just not yet
 * field-precise) for the rest of the taxonomy. */
export type DomainEventPayloadMap = {
  [K in DomainEventType]: K extends keyof DomainEventPayloadOverrides ? DomainEventPayloadOverrides[K] : Record<string, unknown>;
};

/**
 * The real discriminated union: `DomainEvent["type"]` narrows `DomainEvent["payload"]` with no cast, e.g.
 * `if (event.type === "BillDueChanged.v1") event.payload.billId` type-checks; `event.payload.merchantId`
 * (a `PurchaseDetectedPayload`-only field) would not. Every other envelope field is shared across variants
 * (see `DomainEventEnvelopeSchema` in taxonomy.ts, which this stays structurally aligned with).
 */
export type DomainEvent = {
  [K in DomainEventType]: Omit<DomainEventEnvelope, "type" | "payload" | "sensitivity"> & {
    type: K;
    sensitivity: SensitivityTier;
    payload: DomainEventPayloadMap[K];
  };
}[DomainEventType];

export type DomainEventOfType<K extends DomainEventType> = Extract<DomainEvent, { type: K }>;
