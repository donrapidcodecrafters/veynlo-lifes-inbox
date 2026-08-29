import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import type { CreatePersonDto, UpdatePersonDto } from "./dto";

const RELATIONSHIP_LABEL_PREDICATE = "relationship_label";
const IMPORTANT_DATE_PREDICATE = "important_date";

/**
 * PEO-001/002/003/004/005 "Contacts, People & Relationships" — deliberately scoped down. `canonical_
 * entities`/`facts`/`relationships` already existed as a real polymorphic graph (one other real writer:
 * IngestionService's per-purchase-line "asset" entities) with zero writer for `type: "person"` anywhere —
 * this is that writer, not a new schema. Reuses `facts` (predicate/valueJson) for relationship label and
 * important dates rather than new columns, matching the existing per-purchase-line "asset" entity
 * convention. Deliberately NOT built this pass: PEO-001 contact connectors (Google/Microsoft Contacts —
 * `ProviderKeySchema` already lists both provider keys with zero adapter behind either; a real new
 * OAuth-scoped connector is a separate, larger effort, same posture as the deferred CalDAV/IMAP
 * connectors) and PEO-002 cross-source identity resolution/merge (nothing to merge yet without a real
 * second source feeding person entities — building merge UI ahead of real duplicate data was already
 * rejected for inbox items this session for the same reason).
 */
@Injectable()
export class PeopleService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listPeople(userId: string) {
    const people = await this.db
      .select()
      .from(schema.canonicalEntities)
      .where(and(eq(schema.canonicalEntities.ownerUserId, userId), eq(schema.canonicalEntities.type, "person")));
    return Promise.all(people.map((p) => this.withFacts(p)));
  }

  async getPerson(id: string, userId: string) {
    const person = await this.assertOwnedPerson(id, userId);
    return this.withFacts(person);
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
  }

  async deletePerson(id: string, userId: string) {
    const person = await this.assertOwnedPerson(id, userId);
    await this.db.delete(schema.canonicalEntities).where(eq(schema.canonicalEntities.id, person.id));
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
