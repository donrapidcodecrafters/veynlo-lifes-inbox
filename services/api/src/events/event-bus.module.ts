import { Global, Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { EventBusService } from "./event-bus.service";
import { EVENT_BUS } from "./event-bus.interface";
import { DomainEventAuditListener } from "./domain-event-audit.listener";

/**
 * §42.3/42.4 domain event taxonomy — foundational event-bus wiring. Global (same shape as
 * DatabaseModule/QueueModule — see their own doc comments) so every feature module can
 * `@Inject(EVENT_BUS)` (or the concrete `EventBusService`) without importing this module directly.
 *
 * `EventEmitterModule.forRoot()` wires the real `@nestjs/event-emitter` package (confirmed absent from
 * this repo before this change — no event-bus/emitter existed anywhere in services/api/src) rather than a
 * bespoke pub/sub reimplementation, but `DomainEventAuditListener` below subscribes imperatively via
 * `EventBusService.onAny` in its own constructor instead of the package's `@OnEvent` decorator + discovery
 * scan — this codebase has no existing convention of decorator-discovered providers, and imperative
 * subscription is directly constructible/testable the same way every other service here is (`new
 * DomainEventAuditListener(bus, db)`), no Nest test-module bootstrap required. See event-bus.service.ts's
 * own doc comment for the delivery-guarantee stance (in-process, at-most-once, consumers must be
 * idempotent regardless — §42.4's own requirement, not something a synchronous in-memory emitter can
 * relax).
 */
@Global()
@Module({
  imports: [EventEmitterModule.forRoot()],
  providers: [EventBusService, { provide: EVENT_BUS, useExisting: EventBusService }, DomainEventAuditListener],
  exports: [EventBusService, EVENT_BUS],
})
export class EventBusModule {}
