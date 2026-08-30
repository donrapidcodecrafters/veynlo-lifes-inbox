import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { DocumentsService } from "../documents/documents.service";

const VALID_RESOURCE_TYPES = new Set(["purchase", "bill", "warranty", "return_case", "subscription", "calendar_event", "person"]);

/**
 * TIME-002 "Object history" — scoped down from the spec's full model (vehicle/appliance/property/
 * subscription/person/trip detail pages, an `entities`/`relationships`/`facts`/`revisions` graph with
 * supersession tracking) to the six domains that actually have detail pages today, and to what's real
 * without inventing that whole graph: notes, attached documents, and — for purchases specifically, the
 * one domain with a rich enough relational shape to make it worthwhile — directly linked shipments/
 * return cases/warranties. "Compare versions" isn't built: there's no revision/versioning table behind
 * any of these domains (`correct()` overwrites fields in place), so there is nothing to compare yet.
 */
@Injectable()
export class HistoryService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly documents: DocumentsService,
  ) {}

  async getHistory(userId: string, resourceType: string, resourceId: string) {
    if (!VALID_RESOURCE_TYPES.has(resourceType)) {
      throw new BadRequestException({ code: "UNSUPPORTED_RESOURCE_TYPE", message: `History isn't available for "${resourceType}" yet.` });
    }

    const [notes, documents, related] = await Promise.all([
      this.listNotes(userId, resourceType, resourceId),
      this.documents.listLinkedTo(userId, resourceId),
      resourceType === "purchase" ? this.relatedForPurchase(userId, resourceId) : Promise.resolve([]),
    ]);

    return { notes, documents, related };
  }

  private async relatedForPurchase(userId: string, purchaseId: string) {
    const [purchase] = await this.db.select({ id: schema.purchases.id }).from(schema.purchases).where(and(eq(schema.purchases.id, purchaseId), eq(schema.purchases.ownerUserId, userId))).limit(1);
    if (!purchase) return [];

    const [shipments, returnCases, purchaseLines] = await Promise.all([
      this.db.select().from(schema.shipments).where(eq(schema.shipments.purchaseId, purchaseId)),
      this.db.select().from(schema.returnCases).where(eq(schema.returnCases.purchaseId, purchaseId)),
      this.db.select({ id: schema.purchaseLines.id }).from(schema.purchaseLines).where(eq(schema.purchaseLines.purchaseId, purchaseId)),
    ]);

    const lineIds = purchaseLines.map((l) => l.id);
    const warranties = lineIds.length > 0 ? await this.db.select().from(schema.warranties).where(inArray(schema.warranties.purchaseLineId, lineIds)) : [];

    return [
      ...shipments.map((s) => ({ kind: "shipment" as const, id: s.id, label: `${s.carrier} — ${s.status}`, at: (s.deliveredAt ?? s.updatedAt).toISOString() })),
      ...returnCases.map((r) => ({ kind: "return_case" as const, id: r.id, label: `Return — ${r.state}`, at: r.createdAt.toISOString() })),
      ...warranties.map((w) => ({ kind: "warranty" as const, id: w.id, label: w.productLabel, at: w.createdAt.toISOString() })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  }

  async listNotes(userId: string, resourceType: string, resourceId: string) {
    return this.db
      .select()
      .from(schema.objectNotes)
      .where(and(eq(schema.objectNotes.ownerUserId, userId), eq(schema.objectNotes.resourceType, resourceType), eq(schema.objectNotes.resourceId, resourceId)))
      .orderBy(desc(schema.objectNotes.createdAt));
  }

  async addNote(userId: string, resourceType: string, resourceId: string, noteText: string) {
    if (!VALID_RESOURCE_TYPES.has(resourceType)) {
      throw new BadRequestException({ code: "UNSUPPORTED_RESOURCE_TYPE", message: `Notes aren't available for "${resourceType}" yet.` });
    }
    if (!noteText.trim()) {
      throw new BadRequestException({ code: "EMPTY_NOTE", message: "Note can't be empty." });
    }
    await this.assertResourceOwnership(userId, resourceType, resourceId);
    const id = generateId("objectNote");
    await this.db.insert(schema.objectNotes).values({ id, ownerUserId: userId, resourceType, resourceId, noteText });
    return { id, noteText, createdAt: new Date().toISOString() };
  }

  /**
   * Real, previously-missing gap: addNote never verified the caller actually owned `resourceId` before
   * attaching a note to it — every other resource-scoped module in this codebase enforces ownership
   * before a mutation, this one didn't. Not a confidentiality leak on its own (the note is stored under
   * the caller's own ownerUserId, so the resource's real owner never sees it — listNotes/getHistory only
   * ever query objectNotes scoped to (ownerUserId, resourceType, resourceId)), but it let any authenticated
   * user attach a note to an arbitrary resourceId, including one they don't own, which could be used to
   * probe for valid resource IDs. Each resource type needs its own ownership path since not all of them
   * carry ownerUserId directly (return_case/subscription resolve it through a parent row).
   */
  private async assertResourceOwnership(userId: string, resourceType: string, resourceId: string): Promise<void> {
    const found = await (async () => {
      switch (resourceType) {
        case "purchase": {
          const [row] = await this.db.select({ id: schema.purchases.id }).from(schema.purchases).where(and(eq(schema.purchases.id, resourceId), eq(schema.purchases.ownerUserId, userId))).limit(1);
          return Boolean(row);
        }
        case "bill": {
          const [row] = await this.db.select({ id: schema.bills.id }).from(schema.bills).where(and(eq(schema.bills.id, resourceId), eq(schema.bills.ownerUserId, userId))).limit(1);
          return Boolean(row);
        }
        case "warranty": {
          const [row] = await this.db.select({ id: schema.warranties.id }).from(schema.warranties).where(and(eq(schema.warranties.id, resourceId), eq(schema.warranties.ownerUserId, userId))).limit(1);
          return Boolean(row);
        }
        case "return_case": {
          const [row] = await this.db
            .select({ id: schema.returnCases.id })
            .from(schema.returnCases)
            .innerJoin(schema.purchases, eq(schema.purchases.id, schema.returnCases.purchaseId))
            .where(and(eq(schema.returnCases.id, resourceId), eq(schema.purchases.ownerUserId, userId)))
            .limit(1);
          return Boolean(row);
        }
        case "subscription": {
          const [row] = await this.db
            .select({ id: schema.subscriptions.id })
            .from(schema.subscriptions)
            .innerJoin(schema.recurringStreams, eq(schema.recurringStreams.id, schema.subscriptions.recurringStreamId))
            .where(and(eq(schema.subscriptions.id, resourceId), eq(schema.recurringStreams.ownerUserId, userId)))
            .limit(1);
          return Boolean(row);
        }
        case "calendar_event": {
          const [row] = await this.db
            .select({ id: schema.calendarEvents.id })
            .from(schema.calendarEvents)
            .where(and(eq(schema.calendarEvents.id, resourceId), eq(schema.calendarEvents.ownerUserId, userId)))
            .limit(1);
          return Boolean(row);
        }
        case "person": {
          const [row] = await this.db
            .select({ id: schema.canonicalEntities.id })
            .from(schema.canonicalEntities)
            .where(and(eq(schema.canonicalEntities.id, resourceId), eq(schema.canonicalEntities.ownerUserId, userId)))
            .limit(1);
          return Boolean(row);
        }
        default:
          return false; // unreachable — VALID_RESOURCE_TYPES already rejected anything else above
      }
    })();
    if (!found) {
      throw new NotFoundException({ code: "RESOURCE_NOT_FOUND", message: "That item doesn't exist or you don't have access to it." });
    }
  }
}
