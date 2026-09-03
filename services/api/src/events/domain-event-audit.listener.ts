import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DomainEvent } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../database/database.module";
import { EVENT_BUS, type EventBus } from "./event-bus.interface";

/**
 * The one real (non-decorative) consumer proving the bus is genuinely useful: every domain event, of
 * whatever type, gets one row in the existing `audit_events` table (§42.1's own audit trail — see
 * `packages/db/src/schema/audit.ts`; already written to directly, with no separate service wrapper, by
 * `AttentionService`'s `inbox.service.ts` and others — this follows that same direct-insert convention
 * rather than inventing a new `AuditService` abstraction). Before this, only explicit user-initiated
 * mutations got an audit row (a household ACL change, an inbox correction); nothing recorded the
 * system-initiated detections/classifications this event bus now carries (a purchase/bill/subscription
 * getting detected, a fact getting extracted, an attention item getting filed) — those simply left no
 * trace once the resulting row was itself edited or deleted. Subscribing via `onAny` (not one `on(type,
 * ...)` per taxonomy entry) means every event this round's two emitters (`IngestionService`,
 * `AttentionService`) produce is covered today, and any future emitter is covered automatically with zero
 * change here.
 *
 * §42.4 "consumers are idempotent" — `id` is deterministically derived from the domain event's own
 * `eventId` (not a fresh random id per insert attempt) and the insert uses `onConflictDoNothing()`, so
 * replaying the same domain event (this bus doesn't do that today — see EventBusService's own doc comment
 * on why — but a future durable outbox sitting behind the same `EventBus` interface might) writes the
 * audit row at most once rather than duplicating it.
 */
@Injectable()
export class DomainEventAuditListener {
  private readonly logger = new Logger(DomainEventAuditListener.name);

  constructor(
    @Inject(EVENT_BUS) private readonly bus: EventBus,
    @Inject(DATABASE) private readonly db: Database,
  ) {
    this.bus.onAny((event) => this.handle(event));
  }

  private async handle(event: DomainEvent): Promise<void> {
    try {
      await this.db
        .insert(schema.auditEvents)
        .values({
          id: `aud_${event.eventId}`,
          actorType: event.actor.type,
          actorId: event.actor.id,
          action: event.type,
          resourceType: event.aggregateType,
          resourceId: event.aggregateId,
          afterJson: event.payload,
          result: "success",
          occurredAt: new Date(event.occurredAt),
        })
        .onConflictDoNothing();
    } catch (err) {
      // Never let an audit-trail failure surface anywhere the emitter could see it — EventBusService.emit
      // already isolates this via try/catch around emitAsync, this is defense in depth for the specific
      // "DB write itself throws" case (e.g. a still-migrating audit_events table in a fresh environment).
      this.logger.error(`Failed to record audit trail for domain event ${event.type} (${event.eventId}): ${(err as Error).message}`);
    }
  }
}
