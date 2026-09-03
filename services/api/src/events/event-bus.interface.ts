import type { DomainEvent, DomainEventPayloadMap, DomainEventType } from "@veynlo/core";

/**
 * §42.4 event contract rules — everything an emitter needs to supply beyond the payload itself.
 * `EventBusService.emit` fills in `eventId`/`occurredAt`/`recordedAt` and defaults `actor`/`sensitivity`/
 * `correlationId`/`causationId` so a call site only states what it actually knows.
 */
export interface EmitDomainEventParams<K extends DomainEventType> {
  payload: DomainEventPayloadMap[K];
  ownerUserId: string;
  householdId?: string | null;
  /** The resource type/id this event is about, e.g. `{ aggregateType: "bill", aggregateId: billId }`. */
  aggregateType: string;
  aggregateId: string;
  /** Defaults to `{ type: "system", id: null }` — most emitters today (ingestion extraction, attention
   * deadline scans) run as background/system processing, not a direct user action. */
  actor?: { type: "user" | "system" | "service"; id: string | null };
  /** Defaults to "standard". Purchases/bills/subscriptions/facts are usually "sensitive" — callers that
   * know their own domain's tier should pass it explicitly rather than rely on the default. */
  sensitivity?: DomainEvent["sensitivity"];
  /** Defaults to the newly generated eventId (this event starts its own correlation chain). Pass the
   * triggering event/request's correlationId to keep a causal chain queryable as one group. */
  correlationId?: string;
  /** The specific prior event/command that caused this one, if any. Defaults to null. */
  causationId?: string | null;
}

export type DomainEventListener<K extends DomainEventType> = (event: Extract<DomainEvent, { type: K }>) => void | Promise<void>;

export interface EventBus {
  /** Builds the full envelope, dispatches to every registered listener, and returns the event that was
   * sent (so a caller can log/correlate `event.eventId` if it wants to, though nothing requires it). A
   * listener that throws/rejects is caught and logged — never propagated back to the emitter, so a broken
   * consumer can never break the mutation that produced the event. See EventBusService's own doc comment
   * for the full delivery-guarantee stance. */
  emit<K extends DomainEventType>(type: K, params: EmitDomainEventParams<K>): Promise<Extract<DomainEvent, { type: K }>>;
  /** Registers a listener for exactly one event type, typed to that type's own payload shape. */
  on<K extends DomainEventType>(type: K, listener: DomainEventListener<K>): void;
  /** Registers a listener for every domain event this bus ever emits, regardless of type — used by
   * DomainEventAuditListener; most real consumers should prefer `on` with a specific type instead. */
  onAny(listener: (event: DomainEvent) => void | Promise<void>): void;
}

/** TypeScript interfaces have no runtime representation — same reasoning as QUEUE_PRODUCER/DATABASE's own
 * doc comments (queue-producer.interface.ts / database.module.ts). */
export const EVENT_BUS = Symbol("EVENT_BUS");
