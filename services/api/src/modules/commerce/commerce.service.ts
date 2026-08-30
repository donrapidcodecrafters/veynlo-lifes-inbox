import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { ownerOrDelegatedHouseholdCondition } from "../../common/household-scope";
import { HouseholdService } from "../household/household.service";

/**
 * PUR-001's own user actions include "mark gift/returned/sold" — deliberately just this manual subset,
 * not the full state machine `candidate/confirmed/fulfilled/partially_fulfilled` are ingestion-managed
 * states a user marking a purchase's real-world fate should never be able to jump back into.
 */
const USER_SETTABLE_PURCHASE_STATES = new Set(["kept", "return_started", "gifted", "sold", "disposed"]);

/**
 * §40.3 return state machine — previously a total stub: returnCases.state was written once at creation
 * ("eligible") and never updated by anything, with no mutation endpoint at all, despite Home's own
 * "start_return"/"keep_item" suggested actions (AttentionService.scanAndFileDeadlines) pointing at a
 * return_case as if there were something real to do about it. "eligible" itself isn't user-settable —
 * it's the only state a return case is ever created in.
 */
const USER_SETTABLE_RETURN_CASE_STATES = new Set(["return_started", "kept", "returned"]);

@Injectable()
export class CommerceService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly households: HouseholdService,
  ) {}

  /**
   * FAM-006 enforcement — a caregiver delegated "commerce:read" on a household sees that household's
   * purchases/bills/returns/subscriptions/warranties alongside their own, not just their own. Returns a
   * Drizzle condition ORing the caller's own rows with any row belonging to a household they've been
   * delegated commerce:read on; the household branch is omitted entirely when there are none, since
   * `inArray` with an empty array is invalid SQL.
   */
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const householdIds = await this.households.delegatedHouseholdIds(userId, "commerce:read");
    return ownerOrDelegatedHouseholdCondition(userId, householdIds, ownerCol, householdCol);
  }

  /** PUR-001/002 — `merchantId` was captured on every purchase since ingestion shipped but never joined
   * back to a displayable name anywhere; the UI showed "Order #12345" only. Both list and detail now
   * carry `merchantName` alongside the raw row. */
  async purchases(userId: string) {
    const rows = await this.db
      .select({ purchase: schema.purchases, merchantName: schema.merchants.displayName })
      .from(schema.purchases)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId));
    return rows.map((r) => ({ ...r.purchase, merchantName: r.merchantName }));
  }

  async purchaseDetail(purchaseId: string, userId: string) {
    const [row] = await this.db
      .select({ purchase: schema.purchases, merchantName: schema.merchants.displayName })
      .from(schema.purchases)
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
      .where(eq(schema.purchases.id, purchaseId))
      .limit(1);
    if (!row) return null;
    const purchase = row.purchase;
    if (purchase.ownerUserId !== userId) {
      const householdIds = purchase.householdId ? await this.households.delegatedHouseholdIds(userId, "commerce:read") : [];
      if (!purchase.householdId || !householdIds.includes(purchase.householdId)) return null;
    }
    const lines = await this.db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
    const returns = await this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId));
    const shipments = await this.db.select().from(schema.shipments).where(eq(schema.shipments.purchaseId, purchaseId));
    const evidence = await this.evidenceForSourceEvent(purchase.sourceEventId);
    return { purchase: { ...purchase, merchantName: row.merchantName }, lines, returns, shipments, evidence };
  }

  /** PUR-001 "mark gift/returned/sold" — the only mutation this service has beyond field-level `correct()` (see InboxService). */
  async setPurchaseState(purchaseId: string, userId: string, state: string) {
    if (!USER_SETTABLE_PURCHASE_STATES.has(state)) {
      throw new BadRequestException({
        code: "INVALID_PURCHASE_STATE",
        message: `"${state}" isn't a state you can set directly. Allowed: ${[...USER_SETTABLE_PURCHASE_STATES].join(", ")}.`,
      });
    }
    const [purchase] = await this.db.select({ ownerUserId: schema.purchases.ownerUserId }).from(schema.purchases).where(eq(schema.purchases.id, purchaseId)).limit(1);
    if (!purchase) throw new NotFoundException({ code: "PURCHASE_NOT_FOUND", message: "Not found." });
    if (purchase.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your purchase." });
    await this.db.update(schema.purchases).set({ state, updatedAt: new Date() }).where(eq(schema.purchases.id, purchaseId));
  }

  /** PEO-004 "person linkage" — a purchase/bill/warranty is always manually linked to a person (nothing
   * infers "this purchase was for Jane" from evidence today); reused by PeopleService's reverse
   * (person -> linked items) lookup. Strict owner-only, matching setPurchaseState's mutation standard. */
  async setPersonLink(resourceType: "purchase" | "bill" | "warranty", resourceId: string, userId: string, personId: string, linked: boolean): Promise<void> {
    const [person] = await this.db
      .select({ id: schema.canonicalEntities.id })
      .from(schema.canonicalEntities)
      .where(and(eq(schema.canonicalEntities.id, personId), eq(schema.canonicalEntities.type, "person"), eq(schema.canonicalEntities.ownerUserId, userId)))
      .limit(1);
    if (!person) throw new NotFoundException({ code: "PERSON_NOT_FOUND", message: "Not found." });

    const table = resourceType === "purchase" ? schema.purchases : resourceType === "bill" ? schema.bills : schema.warranties;
    const [row] = await this.db.select({ ownerUserId: table.ownerUserId, linkedEntityIds: table.linkedEntityIds }).from(table).where(eq(table.id, resourceId)).limit(1);
    if (!row) throw new NotFoundException({ code: "NOT_FOUND", message: "Not found." });
    if (row.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not yours." });

    const next = linked ? [...new Set([...row.linkedEntityIds, personId])] : row.linkedEntityIds.filter((id) => id !== personId);
    await this.db.update(table).set({ linkedEntityIds: next, updatedAt: new Date() }).where(eq(table.id, resourceId));
  }

  /** §40.3 return state machine — the real mutation Home's "start_return"/"keep_item" suggested actions
   * (and the return-case detail page's own action buttons) actually call. Strict ownership, not
   * assertCommerceAccess's delegate-allowed read access — matching setPurchaseState's same stricter
   * standard for state-changing actions, not just viewing. */
  async setReturnCaseState(returnCaseId: string, userId: string, state: string) {
    if (!USER_SETTABLE_RETURN_CASE_STATES.has(state)) {
      throw new BadRequestException({
        code: "INVALID_RETURN_CASE_STATE",
        message: `"${state}" isn't a state you can set directly. Allowed: ${[...USER_SETTABLE_RETURN_CASE_STATES].join(", ")}.`,
      });
    }
    const [row] = await this.db
      .select({ ownerUserId: schema.purchases.ownerUserId })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(eq(schema.returnCases.id, returnCaseId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "RETURN_CASE_NOT_FOUND", message: "Not found." });
    if (row.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your return." });
    await this.db.update(schema.returnCases).set({ state, updatedAt: new Date() }).where(eq(schema.returnCases.id, returnCaseId));
  }

  /**
   * §39.2/Absolute Product Rule "Evidence before assertion" — "why am I seeing this?" needs at least
   * enough of the original source to recognize it. `source_events` deliberately never stores the full
   * body (see its schema comment), only what was captured at ingest time: subject/snippet/sender and
   * which connection it came from. Returns null when there's genuinely nothing to show (no sourceEventId
   * at all, e.g. seed data or a domain nothing currently traces back to a source) rather than a fake
   * placeholder.
   */
  private async evidenceForSourceEvent(sourceEventId: string | null) {
    if (!sourceEventId) return null;
    const [row] = await this.db
      .select({ event: schema.sourceEvents, connection: schema.connections })
      .from(schema.sourceEvents)
      .leftJoin(schema.connections, eq(schema.connections.id, schema.sourceEvents.connectionId))
      .where(eq(schema.sourceEvents.id, sourceEventId))
      .limit(1);
    if (!row) return null;
    return {
      sourceEventId: row.event.id,
      kind: row.event.kind,
      subjectLine: row.event.subjectLine,
      snippet: row.event.snippet,
      fromAddress: row.event.fromAddress,
      occurredAt: row.event.occurredAt,
      provider: row.connection?.provider ?? null,
      rawContentRef: row.event.rawContentRef,
    };
  }

  /** Bills/warranties have no direct sourceEventId column — traced indirectly via the inbox_items row that filed them (every successful extraction files one; see IngestionService.fileInboxItem). */
  private async evidenceViaInboxItem(linkedResourceType: string, linkedResourceId: string) {
    const [inboxItem] = await this.db
      .select({ sourceEventId: schema.inboxItems.sourceEventId })
      .from(schema.inboxItems)
      .where(and(eq(schema.inboxItems.linkedResourceType, linkedResourceType), eq(schema.inboxItems.linkedResourceId, linkedResourceId)))
      .limit(1);
    return this.evidenceForSourceEvent(inboxItem?.sourceEventId ?? null);
  }

  private async assertCommerceAccess(ownerUserId: string, householdId: string | null, userId: string): Promise<boolean> {
    if (ownerUserId === userId) return true;
    if (!householdId) return false;
    const householdIds = await this.households.delegatedHouseholdIds(userId, "commerce:read");
    return householdIds.includes(householdId);
  }

  async billDetail(billId: string, userId: string) {
    const [bill] = await this.db.select().from(schema.bills).where(eq(schema.bills.id, billId)).limit(1);
    if (!bill || !(await this.assertCommerceAccess(bill.ownerUserId, bill.householdId, userId))) return null;
    return { bill, evidence: await this.evidenceViaInboxItem("bill", billId) };
  }

  async warrantyDetail(warrantyId: string, userId: string) {
    const [warranty] = await this.db.select().from(schema.warranties).where(eq(schema.warranties.id, warrantyId)).limit(1);
    if (!warranty || !(await this.assertCommerceAccess(warranty.ownerUserId, warranty.householdId, userId))) return null;
    return { warranty, evidence: await this.evidenceViaInboxItem("warranty", warrantyId) };
  }

  /** Domains row (§52.1) — shipments were modeled/extracted since ingestion shipped but only ever
   * reachable nested inside a purchase's detail payload, never as their own browsable domain surface. */
  async shipmentDetail(shipmentId: string, userId: string) {
    const [row] = await this.db
      .select({ shipment: schema.shipments, merchantName: schema.merchants.displayName })
      .from(schema.shipments)
      .leftJoin(schema.purchases, eq(schema.purchases.id, schema.shipments.purchaseId))
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
      .where(eq(schema.shipments.id, shipmentId))
      .limit(1);
    if (!row || !(await this.assertCommerceAccess(row.shipment.ownerUserId, row.shipment.householdId, userId))) return null;
    return { shipment: { ...row.shipment, merchantName: row.merchantName }, evidence: await this.evidenceViaInboxItem("shipment", shipmentId) };
  }

  async returnDetail(returnCaseId: string, userId: string) {
    const [row] = await this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(eq(schema.returnCases.id, returnCaseId))
      .limit(1);
    if (!row || !(await this.assertCommerceAccess(row.purchase.ownerUserId, row.purchase.householdId, userId))) return null;
    // No direct evidence trail of its own — a return case is created inside extractReceipt from the same
    // email as its parent purchase, so the parent's source event IS the evidence for the return too.
    return { returnCase: row.returnCase, purchase: row.purchase, evidence: await this.evidenceForSourceEvent(row.purchase.sourceEventId) };
  }

  async subscriptionDetail(subscriptionId: string, userId: string) {
    const [row] = await this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(eq(schema.subscriptions.id, subscriptionId))
      .limit(1);
    if (!row || !(await this.assertCommerceAccess(row.stream.ownerUserId, row.stream.householdId, userId))) return null;
    return { subscription: row.subscription, stream: row.stream, evidence: await this.evidenceViaInboxItem("subscription", subscriptionId) };
  }

  async returns(userId: string) {
    return this.db
      .select({ returnCase: schema.returnCases, purchase: schema.purchases })
      .from(schema.returnCases)
      .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId))
      .orderBy(asc(schema.returnCases.deadlineSort));
  }

  async subscriptions(userId: string) {
    return this.db
      .select({ subscription: schema.subscriptions, stream: schema.recurringStreams })
      .from(schema.subscriptions)
      .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.recurringStreams.ownerUserId, schema.recurringStreams.householdId));
  }

  async bills(userId: string) {
    return this.db
      .select({ bill: schema.bills, stream: schema.recurringStreams })
      .from(schema.bills)
      .leftJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.bills.recurringStreamId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.bills.ownerUserId, schema.bills.householdId))
      .orderBy(asc(schema.bills.dueDateSort));
  }

  async warranties(userId: string) {
    return this.db
      .select()
      .from(schema.warranties)
      .where(await this.ownerOrDelegatedHousehold(userId, schema.warranties.ownerUserId, schema.warranties.householdId))
      .orderBy(asc(schema.warranties.expirationDateSort));
  }

  async shipments(userId: string) {
    const rows = await this.db
      .select({ shipment: schema.shipments, merchantName: schema.merchants.displayName })
      .from(schema.shipments)
      .leftJoin(schema.purchases, eq(schema.purchases.id, schema.shipments.purchaseId))
      .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
      .where(await this.ownerOrDelegatedHousehold(userId, schema.shipments.ownerUserId, schema.shipments.householdId))
      .orderBy(asc(schema.shipments.createdAt));
    return rows.map((r) => ({ ...r.shipment, merchantName: r.merchantName }));
  }
}
