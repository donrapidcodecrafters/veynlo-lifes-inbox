import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { EventBusService } from "./event-bus.service";
import { DomainEventAuditListener } from "./domain-event-audit.listener";

/**
 * Real integration test against a real Postgres, same "requires the local dev Postgres... skips
 * gracefully" shape as ingestion.dedup.test.ts/attention.notify-urgent.test.ts. Proves the one real
 * (non-decorative) consumer this round wires up: every domain event emitted through `EventBusService`
 * reaches `DomainEventAuditListener` (subscribed via `onAny` in its own constructor — no Nest test-module
 * bootstrap needed, just `new DomainEventAuditListener(bus, db)`) and lands as a real row in the existing
 * `audit_events` table with the right actor/action/resource/payload — and that a replayed event (same
 * `eventId`) is idempotent, per §42.4's own "consumers are idempotent" requirement.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("DomainEventAuditListener", () => {
  let db: Database;
  let bus: EventBusService;
  let listener: DomainEventAuditListener;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    bus = new EventBusService();
    listener = new DomainEventAuditListener(bus, db);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `event-audit-${ownerUserId}@example.com`, displayName: "Event Audit Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DomainEventAuditListener tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    // audit_events.actor_id has no FK to users (see audit.ts's schema — deliberately, per its own
    // "immutable, never mutated or deleted except by documented retention policy" doc comment), so
    // deleting the test user alone would NOT cascade these rows away — clean them up explicitly.
    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorId, ownerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("records a real audit_events row when a domain event is emitted through the bus", async () => {
    if (!dbAvailable) return;
    const aggregateId = generateId("bill");
    const emitted = await bus.emit("BillDueChanged.v1", {
      ownerUserId,
      householdId: null,
      aggregateType: "bill",
      aggregateId,
      actor: { type: "user", id: ownerUserId },
      sensitivity: "sensitive",
      payload: {
        billId: aggregateId,
        billerLabel: "Audit Test Electric Co",
        billerCategory: "electric",
        dueDateIso: "2026-10-15T00:00:00.000Z",
        amountDueMinorUnits: 8_800,
        amountDueCurrency: "USD",
        confidenceBand: "high",
        sourceEventId: "src_audit_test",
      },
    });

    const [row] = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, `aud_${emitted.eventId}`));
    expect(row).toBeDefined();
    expect(row!.actorType).toBe("user");
    expect(row!.actorId).toBe(ownerUserId);
    expect(row!.action).toBe("BillDueChanged.v1");
    expect(row!.resourceType).toBe("bill");
    expect(row!.resourceId).toBe(aggregateId);
    expect(row!.result).toBe("success");
    expect(row!.afterJson).toMatchObject({ billId: aggregateId, billerLabel: "Audit Test Electric Co", amountDueMinorUnits: 8_800 });
  });

  it("is idempotent — replaying the identical event (same eventId) writes the audit row at most once", async () => {
    if (!dbAvailable) return;
    const aggregateId = generateId("purchase");
    const now = new Date().toISOString();
    const event = {
      eventId: generateId("domainEvent"),
      type: "PurchaseDetected.v1" as const,
      occurredAt: now,
      recordedAt: now,
      actor: { type: "user" as const, id: ownerUserId },
      ownerUserId,
      householdId: null,
      aggregateType: "purchase",
      aggregateId,
      correlationId: "corr_idempotency_test",
      causationId: null,
      sensitivity: "sensitive" as const,
      payload: {
        purchaseId: aggregateId,
        merchantId: null,
        merchantLabel: "Idempotency Test Co",
        orderNumber: "ORD-1",
        totalMinorUnits: 5_000,
        currency: "USD",
        confidenceBand: "high" as const,
        sourceEventId: "src_idempotency_test",
      },
    };

    // Deliberately reaches the private `handle` directly (not through `bus.emit`, which always mints a
    // fresh eventId) — this is how a future durable-outbox redelivery would look: the exact same envelope,
    // including eventId, processed twice.
    type PlantedEvent = typeof event;
    const listenerWithPrivateAccess = listener as unknown as { handle(plantedEvent: PlantedEvent): Promise<void> };
    await listenerWithPrivateAccess.handle(event);
    await listenerWithPrivateAccess.handle(event);

    const rows = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.id, `aud_${event.eventId}`));
    expect(rows).toHaveLength(1);
  });
});
