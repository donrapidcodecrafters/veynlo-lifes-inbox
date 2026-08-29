import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";

/**
 * PUR-001's own user actions include "mark gift/returned/sold" — deliberately just this manual subset,
 * not the full state machine `candidate/confirmed/fulfilled/partially_fulfilled` are ingestion-managed
 * states a user marking a purchase's real-world fate should never be able to jump back into.
 */
const USER_SETTABLE_PURCHASE_STATES = new Set(["kept", "return_started", "gifted", "sold", "disposed"]);

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
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  async purchases(userId: string) {
    return this.db.select().from(schema.purchases).where(await this.ownerOrDelegatedHousehold(userId, schema.purchases.ownerUserId, schema.purchases.householdId));
  }

  async purchaseDetail(purchaseId: string, userId: string) {
    const [purchase] = await this.db
      .select()
      .from(schema.purchases)
      .where(eq(schema.purchases.id, purchaseId))
      .limit(1);
    if (!purchase) return null;
    if (purchase.ownerUserId !== userId) {
      const householdIds = purchase.householdId ? await this.households.delegatedHouseholdIds(userId, "commerce:read") : [];
      if (!purchase.householdId || !householdIds.includes(purchase.householdId)) return null;
    }
    const lines = await this.db.select().from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId));
    const returns = await this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId));
    const shipments = await this.db.select().from(schema.shipments).where(eq(schema.shipments.purchaseId, purchaseId));
    const evidence = await this.evidenceForSourceEvent(purchase.sourceEventId);
    return { purchase, lines, returns, shipments, evidence };
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
}
