import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { DocumentsService } from "../documents/documents.service";

const VALID_RESOURCE_TYPES = new Set(["purchase", "bill", "warranty", "return_case", "subscription", "calendar_event"]);

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
    const id = generateId("objectNote");
    await this.db.insert(schema.objectNotes).values({ id, ownerUserId: userId, resourceType, resourceId, noteText });
    return { id, noteText, createdAt: new Date().toISOString() };
  }
}
