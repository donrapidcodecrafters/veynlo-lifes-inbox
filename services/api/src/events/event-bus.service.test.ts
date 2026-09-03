import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@veynlo/core";
import { EventBusService } from "./event-bus.service";

/**
 * §42.3/42.4 — proves the foundational event-bus piece in isolation, with no DB/Nest bootstrap needed
 * (mirrors this file's own doc comment: `new EventBusService()` with zero arguments gets a private,
 * fully-functional emitter, exactly like a test wants). The Postgres-backed tests
 * (`domain-event-audit.listener.test.ts`, `ingestion.events.test.ts`, `attention.events.test.ts`) build on
 * top of this same class to prove real emission from real mutation call sites reaches a real listener.
 */
describe("EventBusService", () => {
  it("delivers a typed event to a listener registered for that exact type, with envelope defaults filled in", async () => {
    const bus = new EventBusService();
    const received: Extract<DomainEvent, { type: "BillDueChanged.v1" }>[] = [];
    bus.on("BillDueChanged.v1", (event) => {
      received.push(event);
    });

    const emitted = await bus.emit("BillDueChanged.v1", {
      ownerUserId: "usr_test",
      householdId: null,
      aggregateType: "bill",
      aggregateId: "bil_test",
      payload: {
        billId: "bil_test",
        billerLabel: "Test Electric Co",
        billerCategory: "electric",
        dueDateIso: "2026-10-01T00:00:00.000Z",
        amountDueMinorUnits: 12_345,
        amountDueCurrency: "USD",
        confidenceBand: "high",
        sourceEventId: "src_test",
      },
    });

    expect(received).toHaveLength(1);
    const event = received[0]!;
    // Real typed delivery: no cast needed to read a BillDueChanged-only payload field.
    expect(event.payload.billId).toBe("bil_test");
    expect(event.payload.billerLabel).toBe("Test Electric Co");
    expect(event.type).toBe("BillDueChanged.v1");
    expect(event.eventId.startsWith("devt_")).toBe(true);
    // §42.4 "each event includes event_id, type/version, occurred_at, recorded_at, ... correlation/causation
    // IDs, sensitivity metadata" — defaults asserted explicitly here.
    expect(event.correlationId).toBe(event.eventId); // starts its own correlation chain by default
    expect(event.causationId).toBeNull();
    expect(event.actor).toEqual({ type: "system", id: null });
    expect(event.sensitivity).toBe("standard");
    expect(typeof event.occurredAt).toBe("string");
    expect(new Date(event.occurredAt).toString()).not.toBe("Invalid Date");
    // The value `emit` returns is the exact same event object delivered to listeners.
    expect(emitted).toEqual(event);
  });

  it("lets a caller override actor/sensitivity/correlationId/causationId instead of taking the defaults", async () => {
    const bus = new EventBusService();
    const received: DomainEvent[] = [];
    bus.on("SubscriptionDetected.v1", (event) => {
      received.push(event);
    });

    await bus.emit("SubscriptionDetected.v1", {
      ownerUserId: "usr_test",
      householdId: "hh_test",
      aggregateType: "subscription",
      aggregateId: "sub_test",
      actor: { type: "user", id: "usr_test" },
      sensitivity: "sensitive",
      correlationId: "corr_fixed",
      causationId: "devt_prior",
      payload: {
        subscriptionId: "sub_test",
        recurringStreamId: "rec_test",
        merchantLabel: "Streamflix",
        cadence: "monthly",
        state: "candidate",
        typicalAmountMinorUnits: 999,
        currency: "USD",
        sourceEventId: "src_test",
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]!.actor).toEqual({ type: "user", id: "usr_test" });
    expect(received[0]!.sensitivity).toBe("sensitive");
    expect(received[0]!.correlationId).toBe("corr_fixed");
    expect(received[0]!.causationId).toBe("devt_prior");
    expect(received[0]!.householdId).toBe("hh_test");
  });

  it("does not deliver to a listener registered for a different event type", async () => {
    const bus = new EventBusService();
    const received: DomainEvent[] = [];
    bus.on("PurchaseDetected.v1", (event) => {
      received.push(event);
    });

    await bus.emit("SubscriptionDetected.v1", {
      ownerUserId: "usr_test",
      householdId: null,
      aggregateType: "subscription",
      aggregateId: "sub_other",
      payload: {
        subscriptionId: "sub_other",
        recurringStreamId: "rec_other",
        merchantLabel: "Other Co",
        cadence: "monthly",
        state: "candidate",
        typicalAmountMinorUnits: null,
        currency: null,
        sourceEventId: "src_other",
      },
    });

    expect(received).toHaveLength(0);
  });

  it("onAny receives every event regardless of type — the mechanism DomainEventAuditListener relies on", async () => {
    const bus = new EventBusService();
    const anyReceived: DomainEvent["type"][] = [];
    bus.onAny((event) => {
      anyReceived.push(event.type);
    });

    await bus.emit("BillDueChanged.v1", {
      ownerUserId: "usr_test",
      householdId: null,
      aggregateType: "bill",
      aggregateId: "bil_a",
      payload: { billId: "bil_a", billerLabel: "A", billerCategory: null, dueDateIso: null, amountDueMinorUnits: null, amountDueCurrency: null, confidenceBand: "high", sourceEventId: "src_a" },
    });
    await bus.emit("PurchaseDetected.v1", {
      ownerUserId: "usr_test",
      householdId: null,
      aggregateType: "purchase",
      aggregateId: "pur_a",
      payload: { purchaseId: "pur_a", merchantId: null, merchantLabel: "M", orderNumber: null, totalMinorUnits: null, currency: null, confidenceBand: "high", sourceEventId: "src_a" },
    });

    expect(anyReceived).toEqual(["BillDueChanged.v1", "PurchaseDetected.v1"]);
  });

  it("a throwing type-specific listener is caught/logged, never propagated to the emitter, and does not block the onAny channel", async () => {
    const bus = new EventBusService();
    const anyReceived: DomainEvent[] = [];
    bus.on("PurchaseDetected.v1", () => {
      throw new Error("simulated broken consumer");
    });
    bus.onAny((event) => {
      anyReceived.push(event);
    });

    // Must not throw/reject — a broken consumer can never break the caller that emitted the event.
    await expect(
      bus.emit("PurchaseDetected.v1", {
        ownerUserId: "usr_test",
        householdId: null,
        aggregateType: "purchase",
        aggregateId: "pur_broken",
        payload: { purchaseId: "pur_broken", merchantId: null, merchantLabel: "M", orderNumber: null, totalMinorUnits: null, currency: null, confidenceBand: "high", sourceEventId: "src_broken" },
      }),
    ).resolves.toBeDefined();

    // The onAny channel is dispatched independently of the type-specific channel, so it still fires.
    expect(anyReceived).toHaveLength(1);
    expect(anyReceived[0]!.aggregateId).toBe("pur_broken");
  });
});
