import { Injectable, Logger, Optional } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { generateId, type DomainEvent, type DomainEventType } from "@veynlo/core";
import type { EmitDomainEventParams, EventBus } from "./event-bus.interface";

/**
 * §42.3/42.4 "Domain event taxonomy" / "Event contract rules" — before this existed, there was no
 * event-bus/emitter anywhere in services/api/src at all (confirmed live: no hits for `.emit(`, no events
 * directory); cross-module reactions happened exclusively via direct service method calls (e.g.
 * `AttentionService` calling `NotificationDeliveryService.createAndEnqueue` straight from
 * `notifyIfUrgent`). That direct-call style is still exactly right for anything a mutation's own
 * transaction needs to guarantee happened — this bus is deliberately NOT a replacement for it.
 *
 * What this genuinely is: an in-process, synchronous-dispatch pub/sub layer (backed by the real
 * `@nestjs/event-emitter` package, not a bespoke reimplementation) for OPTIONAL side effects that
 * shouldn't block or be able to fail the mutation that triggered them — logging/audit trails, future
 * search reindexing, future automation triggers, anything read-model-shaped. §42.4 requires "exactly-once
 * business effects... through idempotency/transactional outbox/inbox patterns, not assumptions about
 * message-broker delivery" — this bus makes no delivery-guarantee claim beyond "every listener registered
 * at emit time is invoked, in-process, before `emit()` resolves" (via `emitAsync`, so a test can `await
 * ingestion.ingestManualText(...)` and immediately assert a listener already ran with no race). It is NOT
 * durable: an event emitted with no process running to receive it is simply gone, same as any plain
 * function call would be. A future durable outbox (a real Postgres table + worker drain) would sit BEHIND
 * this same `EventBus` interface without changing any emitter call site — deliberately not built here
 * since nothing downstream needs cross-process/durable delivery yet (the one real consumer added alongside
 * this, `DomainEventAuditListener`, runs in the same process as every emitter). See §42.4's own "idempotent
 * consumers" requirement — this is why `DomainEventAuditListener` derives a deterministic id from
 * `eventId` and uses `onConflictDoNothing` rather than assuming at-most-once delivery.
 *
 * A listener that throws (or whose returned promise rejects) is caught here and logged, never propagated
 * to the caller — this is the concrete mechanism behind "a broken consumer can't break the mutation that
 * emitted the event" (see `emit`'s own doc comment on the `EventBus` interface).
 */
@Injectable()
export class EventBusService implements EventBus {
  private readonly logger = new Logger(EventBusService.name);
  private readonly emitter: EventEmitter2;

  /** `@Optional()` so a test can `new EventBusService()` with zero arguments — mirrors this codebase's
   * existing "optional trailing constructor param" convention (see IngestionService's constructor doc
   * comments) applied to a service that's usually only ever constructed via Nest DI in production. Real
   * app wiring (event-bus.module.ts) supplies the one process-wide `EventEmitter2` from
   * `EventEmitterModule.forRoot()`; a bare `new EventBusService()` gets its own private instance, which is
   * exactly what a test wants — real emit/listener wiring, isolated from every other test's bus. */
  constructor(@Optional() emitter?: EventEmitter2) {
    this.emitter = emitter ?? new EventEmitter2();
  }

  /** A single fixed channel every event is also published to, so `onAny` can subscribe once instead of
   * once per taxonomy type. Deliberately not EventEmitter2's own `wildcard`/`*` feature (that would require
   * every real listener's `type` argument to be a valid glob-safe string forever — the taxonomy's own
   * `Type.vN` dotted-version naming already collides with EventEmitter2's default `.` namespace
   * delimiter). */
  private static readonly ANY_EVENT = "domain-event";

  async emit<K extends DomainEventType>(type: K, params: EmitDomainEventParams<K>): Promise<Extract<DomainEvent, { type: K }>> {
    const eventId = generateId("domainEvent");
    const now = new Date().toISOString();
    const event = {
      eventId,
      type,
      occurredAt: now,
      recordedAt: now,
      actor: params.actor ?? { type: "system", id: null },
      ownerUserId: params.ownerUserId,
      householdId: params.householdId ?? null,
      aggregateType: params.aggregateType,
      aggregateId: params.aggregateId,
      correlationId: params.correlationId ?? eventId,
      causationId: params.causationId ?? null,
      sensitivity: params.sensitivity ?? "standard",
      payload: params.payload,
    } as Extract<DomainEvent, { type: K }>;

    // Two independent try/catches, not one wrapping both calls — a throwing type-specific listener must
    // not stop the ANY_EVENT channel (DomainEventAuditListener's own subscription) from still firing, and
    // vice versa. Each channel's own set of listeners is further subject to eventemitter2's own
    // same-channel ordering: a listener that throws SYNCHRONOUSLY does stop any later listener registered
    // on that exact same channel from running in this dispatch (Promise.all only wraps the promises
    // already collected before the throw) — a real limitation of the underlying library, not something
    // this wrapper can fix without re-implementing dispatch itself. Today only one listener exists per
    // channel in this codebase, so it isn't observable yet; a second same-channel listener added later
    // should stay defensive in its own body rather than relying on ordering here.
    try {
      await this.emitter.emitAsync(type, event);
    } catch (err) {
      this.logger.error(`Domain event listener failed for ${type} (eventId=${eventId}): ${(err as Error).message}`, (err as Error).stack);
    }
    try {
      await this.emitter.emitAsync(EventBusService.ANY_EVENT, event);
    } catch (err) {
      this.logger.error(`Domain event 'onAny' listener failed for ${type} (eventId=${eventId}): ${(err as Error).message}`, (err as Error).stack);
    }
    return event;
  }

  on<K extends DomainEventType>(type: K, listener: (event: Extract<DomainEvent, { type: K }>) => void | Promise<void>): void {
    this.emitter.on(type, listener as (...args: unknown[]) => void);
  }

  onAny(listener: (event: DomainEvent) => void | Promise<void>): void {
    this.emitter.on(EventBusService.ANY_EVENT, listener as (...args: unknown[]) => void);
  }
}
