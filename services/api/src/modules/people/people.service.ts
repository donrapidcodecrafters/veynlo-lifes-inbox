import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { SearchIndexService } from "../search/search-index.service";
import type { CreatePersonDto, UpdatePersonDto } from "./dto";

const RELATIONSHIP_LABEL_PREDICATE = "relationship_label";
const IMPORTANT_DATE_PREDICATE = "important_date";

/** Lowercase, strip punctuation, collapse whitespace — a person's own name has no legal-suffix noise to
 * strip the way a business name does (see AdminService.normalizeMerchantName), so this stays simple. */
export function normalizePersonName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * PEO-001/002/003/004/005 "Contacts, People & Relationships" — deliberately scoped down. `canonical_
 * entities`/`facts`/`relationships` already existed as a real polymorphic graph (one other real writer:
 * IngestionService's per-purchase-line "asset" entities) with zero writer for `type: "person"` anywhere —
 * this is that writer, not a new schema. Reuses `facts` (predicate/valueJson) for relationship label and
 * important dates rather than new columns, matching the existing per-purchase-line "asset" entity
 * convention. Deliberately NOT built this pass: PEO-001 contact connectors (Google/Microsoft Contacts —
 * `ProviderKeySchema` already lists both provider keys with zero adapter behind either; a real new
 * OAuth-scoped connector is a separate, larger effort, same posture as the deferred CalDAV/IMAP
 * connectors).
 *
 * PEO-002 "cross-source identity resolution/merge" — unlike merchant merge (AdminService, an admin action
 * on global/shared reference data), a person entity is this user's own private data, so merge here is a
 * user-initiated action on their own contacts, not an admin one — matching entity_merge_lineage's own
 * `actorUserId` (a user, not an admin) rather than merchant_merge_lineage's `actorAdminId`. `relationships`
 * has zero writers anywhere in the app today, so merge only ever needs to repoint `facts`, not
 * relationships — nothing else references a person entity yet.
 */
@Injectable()
export class PeopleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly searchIndex: SearchIndexService,
  ) {}

  async listPeople(userId: string) {
    const people = await this.db
      .select()
      .from(schema.canonicalEntities)
      .where(
        and(
          eq(schema.canonicalEntities.ownerUserId, userId),
          eq(schema.canonicalEntities.type, "person"),
          isNull(schema.canonicalEntities.mergedIntoEntityId),
        ),
      );
    return Promise.all(people.map((p) => this.withFacts(p)));
  }

  /** Groups active contacts by a normalized display name so a user can spot likely duplicates ("Jon
   * Smith" / "jon smith") without hand-searching — a heuristic surfaced for the user to confirm, never an
   * automatic merge, same posture as AdminService.findDuplicateMerchantCandidates. */
  async findDuplicatePersonCandidates(userId: string) {
    const people = await this.db
      .select()
      .from(schema.canonicalEntities)
      .where(
        and(
          eq(schema.canonicalEntities.ownerUserId, userId),
          eq(schema.canonicalEntities.type, "person"),
          isNull(schema.canonicalEntities.mergedIntoEntityId),
        ),
      );
    const groups = new Map<string, typeof people>();
    for (const person of people) {
      const key = normalizePersonName(person.displayLabel);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(person);
      else groups.set(key, [person]);
    }
    const withFacts = await Promise.all(
      [...groups.values()].filter((group) => group.length > 1).map((group) => Promise.all(group.map((p) => this.withFacts(p)))),
    );
    return withFacts;
  }

  /** Includes each side's display name — the merged-away contact's row still exists (merge only flags it
   * via `mergedIntoEntityId`, never deletes it), so this is a real decrypted read, not a stale snapshot. */
  async listPersonMergeLineage(userId: string, limit = 50) {
    const lineage = await this.db
      .select()
      .from(schema.entityMergeLineage)
      .where(eq(schema.entityMergeLineage.actorUserId, userId))
      .orderBy(desc(schema.entityMergeLineage.mergedAt))
      .limit(limit);
    return Promise.all(
      lineage.map(async (entry) => {
        const [surviving, merged] = await Promise.all([
          this.db.select({ displayLabel: schema.canonicalEntities.displayLabel }).from(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, entry.survivingEntityId)).limit(1),
          this.db.select({ displayLabel: schema.canonicalEntities.displayLabel }).from(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, entry.mergedEntityId)).limit(1),
        ]);
        return { ...entry, survivingDisplayLabel: surviving[0]?.displayLabel ?? null, mergedDisplayLabel: merged[0]?.displayLabel ?? null };
      }),
    );
  }

  /**
   * Merges `mergedId` into `survivingId`: repoints every fact from the merged contact to the surviving
   * one and records exactly which facts were repointed (so unmerge only reverses this merge's effects),
   * flagging the merged contact via `mergedIntoEntityId` rather than deleting it — same pattern as
   * AdminService.mergeMerchants.
   */
  async mergePeople(survivingId: string, mergedId: string, userId: string) {
    if (survivingId === mergedId) {
      throw new BadRequestException({ code: "SAME_PERSON", message: "Cannot merge a contact into itself." });
    }
    await this.assertOwnedPerson(survivingId, userId);
    const merged = await this.assertOwnedPerson(mergedId, userId);
    if (merged.mergedIntoEntityId) {
      throw new BadRequestException({ code: "ALREADY_MERGED", message: "That contact was already merged into another one." });
    }

    const repointed = await this.db.select({ id: schema.facts.id }).from(schema.facts).where(eq(schema.facts.subjectEntityId, mergedId));
    const repointedFactIds = repointed.map((f) => f.id);

    await this.db.update(schema.facts).set({ subjectEntityId: survivingId }).where(eq(schema.facts.subjectEntityId, mergedId));
    await this.db.update(schema.canonicalEntities).set({ mergedIntoEntityId: survivingId, updatedAt: new Date() }).where(eq(schema.canonicalEntities.id, mergedId));

    const lineageId = generateId("entityMergeLineage");
    await this.db.insert(schema.entityMergeLineage).values({
      id: lineageId,
      survivingEntityId: survivingId,
      mergedEntityId: mergedId,
      reason: "user_initiated_merge",
      algorithmVersion: "manual_v1",
      confidenceScore: 1,
      actorUserId: userId,
      repointedFactIds,
    });

    return { lineageId, repointedFactCount: repointedFactIds.length };
  }

  /** Reverses exactly one merge: restores the merged contact and repoints only the facts that merge actually moved. */
  async unmergePeople(lineageId: string, userId: string) {
    const [lineage] = await this.db.select().from(schema.entityMergeLineage).where(eq(schema.entityMergeLineage.id, lineageId)).limit(1);
    if (!lineage || lineage.actorUserId !== userId) throw new NotFoundException({ code: "MERGE_NOT_FOUND", message: "That merge record was not found." });
    if (lineage.unmergedAt) {
      throw new BadRequestException({ code: "ALREADY_UNMERGED", message: "That merge was already undone." });
    }

    await this.db.update(schema.canonicalEntities).set({ mergedIntoEntityId: null, updatedAt: new Date() }).where(eq(schema.canonicalEntities.id, lineage.mergedEntityId));
    for (const factId of lineage.repointedFactIds) {
      await this.db.update(schema.facts).set({ subjectEntityId: lineage.mergedEntityId }).where(eq(schema.facts.id, factId));
    }
    await this.db.update(schema.entityMergeLineage).set({ unmergedAt: new Date() }).where(eq(schema.entityMergeLineage.id, lineageId));

    return { restoredFactCount: lineage.repointedFactIds.length };
  }

  async getPerson(id: string, userId: string) {
    const person = await this.assertOwnedPerson(id, userId);
    return this.withFacts(person);
  }

  /** PEO-004 "person linkage" — the reverse of CommerceService.setPersonLink/ScheduleService.
   * setEventPersonLink: everything this user has manually linked to this person, across every resource
   * type that supports it. Matches DocumentsService.documentsLinkedTo's own approach (fetch this user's
   * own rows, filter by array membership in application code) rather than a jsonb containment query. */
  async linkedItems(id: string, userId: string) {
    await this.assertOwnedPerson(id, userId);
    const [purchaseRows, billRows, warrantyRows, eventRows] = await Promise.all([
      this.db
        .select({ purchase: schema.purchases, merchantName: schema.merchants.displayName })
        .from(schema.purchases)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.purchases.merchantId))
        .where(eq(schema.purchases.ownerUserId, userId)),
      this.db.select().from(schema.bills).where(eq(schema.bills.ownerUserId, userId)),
      this.db.select().from(schema.warranties).where(eq(schema.warranties.ownerUserId, userId)),
      this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, userId)),
    ]);
    return {
      purchases: purchaseRows
        .filter((r) => r.purchase.linkedEntityIds.includes(id))
        .map((r) => ({ id: r.purchase.id, merchantName: r.merchantName, purchaseDate: r.purchase.purchaseDate, totalMinorUnits: r.purchase.totalMinorUnits, totalCurrency: r.purchase.totalCurrency })),
      bills: billRows
        .filter((b) => b.linkedEntityIds.includes(id))
        .map((b) => ({ id: b.id, billerLabel: b.billerLabel, dueDate: b.dueDate, amountDueMinorUnits: b.amountDueMinorUnits, amountDueCurrency: b.amountDueCurrency })),
      warranties: warrantyRows
        .filter((w) => w.linkedEntityIds.includes(id))
        .map((w) => ({ id: w.id, productLabel: w.productLabel, expirationDate: w.expirationDate })),
      events: eventRows
        .filter((e) => e.relatedEntityIds.includes(id))
        .map((e) => ({ id: e.id, title: e.title, start: e.start })),
    };
  }

  async createPerson(userId: string, householdId: string | null, dto: CreatePersonDto) {
    const id = generateId("entity");
    await this.db.insert(schema.canonicalEntities).values({
      id,
      type: "person",
      ownerUserId: userId,
      householdId,
      displayLabel: dto.displayLabel,
      aliases: [], // encryptedJsonb columns don't get a working DB-level default — see documents.tags' history
      lifecycleState: "active",
    });
    if (dto.relationshipLabel) await this.setRelationshipLabel(id, dto.relationshipLabel);
    for (const date of dto.importantDates ?? []) await this.addImportantDate(id, date.label, date.dateIso);
    // §54.2 launch criteria #2/ASK-001 — people were never indexed at all, so Ask couldn't answer
    // "who is X"/contractor-history-style questions naming a person by name.
    await this.searchIndex.upsert({
      resourceType: "person",
      resourceId: id,
      ownerUserId: userId,
      householdId,
      title: dto.displayLabel,
      bodyText: dto.relationshipLabel ?? "",
    });
    return { id };
  }

  async updatePerson(id: string, userId: string, dto: UpdatePersonDto) {
    const person = await this.assertOwnedPerson(id, userId);
    if (dto.displayLabel !== undefined) {
      await this.db.update(schema.canonicalEntities).set({ displayLabel: dto.displayLabel, updatedAt: new Date() }).where(eq(schema.canonicalEntities.id, person.id));
    }
    if (dto.relationshipLabel !== undefined) {
      if (dto.relationshipLabel) await this.setRelationshipLabel(person.id, dto.relationshipLabel);
      else await this.db.delete(schema.facts).where(and(eq(schema.facts.subjectEntityId, person.id), eq(schema.facts.predicate, RELATIONSHIP_LABEL_PREDICATE)));
    }
    if (dto.importantDates !== undefined) {
      // Replace-the-whole-list semantics — simplest correct behavior for an edit form that always submits
      // its complete current set, rather than trying to diff individual date entries.
      await this.db.delete(schema.facts).where(and(eq(schema.facts.subjectEntityId, person.id), eq(schema.facts.predicate, IMPORTANT_DATE_PREDICATE)));
      for (const date of dto.importantDates) await this.addImportantDate(person.id, date.label, date.dateIso);
    }
    if (dto.displayLabel !== undefined || dto.relationshipLabel !== undefined) {
      await this.searchIndex.upsert({
        resourceType: "person",
        resourceId: person.id,
        ownerUserId: userId,
        householdId: person.householdId,
        title: dto.displayLabel ?? person.displayLabel,
        bodyText: dto.relationshipLabel ?? "",
      });
    }
  }

  async deletePerson(id: string, userId: string) {
    const person = await this.assertOwnedPerson(id, userId);
    await this.db.delete(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, person.id));
    await this.searchIndex.remove("person", person.id);
  }

  private async setRelationshipLabel(entityId: string, label: string) {
    await this.db.delete(schema.facts).where(and(eq(schema.facts.subjectEntityId, entityId), eq(schema.facts.predicate, RELATIONSHIP_LABEL_PREDICATE)));
    await this.insertFact(entityId, RELATIONSHIP_LABEL_PREDICATE, { label });
  }

  private async addImportantDate(entityId: string, label: string, dateIso: string) {
    if (Number.isNaN(Date.parse(dateIso))) throw new BadRequestException({ code: "INVALID_DATE", message: `"${dateIso}" isn't a valid date.` });
    await this.insertFact(entityId, IMPORTANT_DATE_PREDICATE, { label, dateIso });
  }

  private async insertFact(subjectEntityId: string, predicate: string, valueJson: unknown) {
    await this.db.insert(schema.facts).values({
      id: generateId("fact"),
      subjectEntityId,
      predicate,
      valueJson,
      extractionMethod: "user_entered",
      extractorVersion: "manual_v1",
      confidenceScore: 1,
      confidenceBand: "verified",
      verification: "user_confirmed",
    });
  }

  private async withFacts(person: typeof schema.canonicalEntities.$inferSelect) {
    const allFacts = await this.db.select().from(schema.facts).where(eq(schema.facts.subjectEntityId, person.id));
    const relationshipLabel = (allFacts.find((f) => f.predicate === RELATIONSHIP_LABEL_PREDICATE)?.valueJson as { label: string } | undefined)?.label ?? null;
    const importantDates = allFacts
      .filter((f) => f.predicate === IMPORTANT_DATE_PREDICATE)
      .map((f) => f.valueJson as { label: string; dateIso: string });
    return { id: person.id, displayLabel: person.displayLabel, relationshipLabel, importantDates };
  }

  private async assertOwnedPerson(id: string, userId: string) {
    const [person] = await this.db.select().from(schema.canonicalEntities).where(and(eq(schema.canonicalEntities.id, id), eq(schema.canonicalEntities.type, "person"))).limit(1);
    if (!person) throw new NotFoundException({ code: "PERSON_NOT_FOUND", message: "Not found." });
    if (person.ownerUserId !== userId) throw new BadRequestException({ code: "NOT_OWNER", message: "Not your contact." });
    return person;
  }
}
