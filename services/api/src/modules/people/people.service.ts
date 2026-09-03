import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, ne, or } from "drizzle-orm";
import { generateId, isIdOfKind, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import type { ResourceGrantRight } from "../sharing/dto";
import { temporalToSortDate } from "../ingestion/temporal.util";
import type {
  CreatePersonDto,
  UpdatePersonDto,
  AddAliasDto,
  AddPersonNoteDto,
  AddImportantDateDto,
  AddPersonRelationshipDto,
  CreateOrganizationDto,
} from "./dto";

/** Suggestion-only, deliberately tiny inference table (PEO-003 "avoid sensitive identity inference beyond
 * product need" / "inferred labels stay candidate unless high-confidence benign context") — maps a
 * benign, already-user-provided `organizations.organizationType` to a plausible relationship label. Never
 * runs unless the user already told us the organization's type; never overwrites a label the user set
 * themselves; always lands as `relationshipLabelSource: "suggested"`, never applied silently. */
const ORGANIZATION_TYPE_LABEL_SUGGESTIONS: Record<string, string> = {
  medical: "doctor",
  dental: "dentist",
  school: "teacher",
};

function dateOnly(iso: string): TemporalValue {
  return { precision: "date", instantUtc: null, date: iso.slice(0, 10), timezone: null, sourceText: null };
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string): string {
  const digits = value.replace(/\D+/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits; // last 10 digits — drops a leading country code
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Domains a person's `relatedEntityIds` (PEO-004 "generic linking mechanism") can point into, and the
 * minimal columns needed to both display and ownership-check a linked row. Mirrors the id-prefix dispatch
 * `isIdOfKind` already exists for (packages/core/src/util/ids.ts). */
const LINKABLE_ENTITY_KINDS = ["bill", "document", "maintenanceRecord", "calendarEvent", "task", "warranty", "vehicle", "property"] as const;
type LinkableEntityKind = (typeof LINKABLE_ENTITY_KINDS)[number];

/**
 * §14 "Contacts, People & Relationships" (PEO-001..005). Structurally mirrors PetsService/
 * HealthLogisticsService closely: PetsService's `ownerOrDelegatedHousehold` + SharingService grant shape
 * for CRUD access, HealthLogisticsService's PRIVATE-BY-DEFAULT discipline for visibility (this module never
 * OR's plain `activeHouseholdIds` membership into access the way Pets/Assets/Lists do — only an explicit
 * `visibility: "household"` the owner opts a specific person into, mirroring HealthLogisticsService's own
 * class doc comment word for word). Reversible merge (PEO-002) mirrors AdminService.mergeMerchants'
 * snapshot+repoint+lineage shape exactly, adapted to this domain's five satellite tables.
 */
@Injectable()
export class PeopleService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
  ) {}

  // ---------------------------------------------------------------------------------------------------
  // Access control — see this class's own doc comment for why this deliberately does NOT mirror Pets'
  // plain-membership-OR'd shape.
  // ---------------------------------------------------------------------------------------------------

  private async accessCondition(userId: string) {
    const delegatedIds = await this.households.delegatedHouseholdIds(userId, "people:read");
    const grantedIds = await this.sharing.grantedResourceIds("person", userId);
    const conditions = [eq(schema.people.ownerUserId, userId)];
    if (delegatedIds.length > 0) {
      conditions.push(and(inArray(schema.people.householdId, delegatedIds), ne(schema.people.visibility, "private"))!);
    }
    if (grantedIds.length > 0) conditions.push(inArray(schema.people.id, grantedIds));
    return or(...conditions)!;
  }

  private async isOwnerOrHousehold(ownerUserId: string, householdId: string | null, visibility: string, userId: string): Promise<boolean> {
    if (ownerUserId === userId) return true;
    if (!householdId || visibility === "private") return false;
    const delegatedIds = await this.households.delegatedHouseholdIds(userId, "people:read");
    return delegatedIds.includes(householdId);
  }

  private async assertAccess(person: typeof schema.people.$inferSelect, userId: string, requiredRight: ResourceGrantRight = "view"): Promise<void> {
    if (await this.isOwnerOrHousehold(person.ownerUserId, person.householdId, person.visibility, userId)) return;
    if (await this.sharing.hasGrantAtLeast("person", person.id, userId, requiredRight)) {
      // §35 SHARE-007 "access_audit" — this resource's own read gate needs the grant's right (view vs.
      // edit), so it can't use SharingService.hasActiveGrant the way every other resource's detail-fetch
      // gate does; recordGrantAccess is the explicit equivalent for exactly this shape of gate.
      await this.sharing.recordGrantAccess("person", person.id, userId);
      return;
    }
    throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this person." });
  }

  private async loadPerson(personId: string): Promise<typeof schema.people.$inferSelect> {
    const [person] = await this.db.select().from(schema.people).where(eq(schema.people.id, personId)).limit(1);
    if (!person || person.deletedAt || person.mergedIntoPersonId) throw new NotFoundException({ code: "PERSON_NOT_FOUND", message: "Person not found." });
    return person;
  }

  private async assertOwned(personId: string, userId: string, requiredRight: ResourceGrantRight = "edit") {
    const person = await this.loadPerson(personId);
    if (person.ownerUserId === userId) return person;
    if (await this.sharing.hasGrantAtLeast("person", personId, userId, requiredRight)) return person;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or someone with sufficient shared access can edit this person." });
  }

  // ---------------------------------------------------------------------------------------------------
  // CRUD (PEO-001)
  // ---------------------------------------------------------------------------------------------------

  async list(userId: string) {
    const access = await this.accessCondition(userId);
    return this.db
      .select()
      .from(schema.people)
      .where(and(access, isNull(schema.people.deletedAt), isNull(schema.people.mergedIntoPersonId)))
      .orderBy(asc(schema.people.displayName));
  }

  async create(userId: string, dto: CreatePersonDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    let organization: typeof schema.organizations.$inferSelect | undefined;
    if (dto.organizationId) {
      [organization] = await this.db.select().from(schema.organizations).where(eq(schema.organizations.id, dto.organizationId)).limit(1);
      if (!organization || organization.ownerUserId !== userId) throw new BadRequestException({ code: "INVALID_ORGANIZATION", message: "That organization isn't yours." });
    }

    // PEO-003 minimal suggestion — only when the user didn't already supply a label AND the organization's
    // own (user-provided) type maps to a benign guess. Always "suggested", never applied if the user did
    // provide a label themselves.
    const suggestion = !dto.relationshipLabel && organization?.organizationType ? ORGANIZATION_TYPE_LABEL_SUGGESTIONS[organization.organizationType] : undefined;

    const id = generateId("person");
    await this.db.insert(schema.people).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      displayName: dto.displayName,
      organizationId: dto.organizationId ?? null,
      relationshipLabel: dto.relationshipLabel ?? suggestion ?? null,
      relationshipLabelSource: dto.relationshipLabel ? "user_set" : suggestion ? "suggested" : "user_set",
      isImportant: dto.isImportant ?? false,
      // PEO-001 "avoid sensitive identity inference beyond product need" — private by default, always,
      // regardless of householdId; see setVisibility for the owner's explicit opt-in.
      visibility: "private",
    });

    for (const email of dto.emails ?? []) {
      await this.db.insert(schema.aliases).values({ id: generateId("alias"), personId: id, ownerUserId: userId, kind: "email", value: email });
    }
    for (const phone of dto.phones ?? []) {
      await this.db.insert(schema.aliases).values({ id: generateId("alias"), personId: id, ownerUserId: userId, kind: "phone", value: phone });
    }
    // PEO-001 "Contact sources remain evidence" — a person created directly through this endpoint (as
    // opposed to a provider sync's own `contactSources` insert — see the Google/Microsoft contacts
    // adapters) gets a source row recording exactly how they were added: "manual" (typed in directly) by
    // default, or "apple_local" when this create call came from the mobile device-contacts one-time import
    // flow (`dto.source` — see CreatePersonDtoSchema's own doc comment). Either way `contactSources` stays
    // a complete evidence trail for every person regardless of how they were added.
    await this.db.insert(schema.contactSources).values({ id: generateId("contactSource"), personId: id, ownerUserId: userId, provider: dto.source ?? "manual" });
    return { id };
  }

  async detail(personId: string, userId: string) {
    const person = await this.loadPerson(personId);
    await this.assertAccess(person, userId);
    const sharedNote = (await this.isOwnerOrHousehold(person.ownerUserId, person.householdId, person.visibility, userId))
      ? null
      : await this.sharing.grantMessage("person", personId, userId);

    const [organization, aliases, contactSources, notes, importantDates, relationshipsFrom, relationshipsTo] = await Promise.all([
      person.organizationId ? this.db.select().from(schema.organizations).where(eq(schema.organizations.id, person.organizationId)).limit(1).then((r) => r[0] ?? null) : Promise.resolve(null),
      this.db.select().from(schema.aliases).where(eq(schema.aliases.personId, personId)),
      this.db.select().from(schema.contactSources).where(eq(schema.contactSources.personId, personId)),
      this.db
        .select()
        .from(schema.personNotes)
        .where(and(eq(schema.personNotes.personId, personId), isNull(schema.personNotes.deletedAt)))
        .orderBy(desc(schema.personNotes.createdAt)),
      this.db
        .select()
        .from(schema.personImportantDates)
        .where(and(eq(schema.personImportantDates.personId, personId), isNull(schema.personImportantDates.deletedAt)))
        .orderBy(asc(schema.personImportantDates.dateSort)),
      this.db.select().from(schema.personRelationships).where(eq(schema.personRelationships.fromPersonId, personId)),
      this.db.select().from(schema.personRelationships).where(eq(schema.personRelationships.toPersonId, personId)),
    ]);

    // PEO-005 "sensitive date categories can be private" — a non-owner (household/grant access) never sees
    // a date marked isSensitive, regardless of how the parent person itself is shared.
    const visibleImportantDates = person.ownerUserId === userId ? importantDates : importantDates.filter((d) => !d.isSensitive);

    const linkedHistory = await this.resolveRelatedEntities(person);

    return {
      person,
      organization,
      aliases,
      contactSources,
      notes,
      importantDates: visibleImportantDates,
      relationships: { from: relationshipsFrom, to: relationshipsTo },
      linkedHistory,
      sharedNote,
    };
  }

  /** PEO-004 "Provider/contractor history" — resolves `person.relatedEntityIds` against whichever domain
   * table each id belongs to (by prefix — see LINKABLE_ENTITY_KINDS), scoped to the person's own owner so a
   * stale/foreign id can never leak another owner's row. Returns an object keyed by kind so the UI can
   * render "Jobs", "Bills", "Documents", etc. sections directly. */
  private async resolveRelatedEntities(person: typeof schema.people.$inferSelect) {
    const ids = person.relatedEntityIds;
    const result: Record<LinkableEntityKind, unknown[]> = {
      bill: [],
      document: [],
      maintenanceRecord: [],
      calendarEvent: [],
      task: [],
      warranty: [],
      vehicle: [],
      property: [],
    };
    if (ids.length === 0) return result;

    const billIds = ids.filter((id) => isIdOfKind(id, "bill"));
    const documentIds = ids.filter((id) => isIdOfKind(id, "document"));
    const maintenanceIds = ids.filter((id) => isIdOfKind(id, "maintenanceRecord"));
    const eventIds = ids.filter((id) => isIdOfKind(id, "calendarEvent"));
    const taskIds = ids.filter((id) => isIdOfKind(id, "task"));
    const warrantyIds = ids.filter((id) => isIdOfKind(id, "warranty"));
    const vehicleIds = ids.filter((id) => isIdOfKind(id, "vehicle"));
    const propertyIds = ids.filter((id) => isIdOfKind(id, "property"));

    const [bills, documents, maintenance, events, tasks, warranties, vehicles, properties] = await Promise.all([
      billIds.length ? this.db.select().from(schema.bills).where(and(inArray(schema.bills.id, billIds), eq(schema.bills.ownerUserId, person.ownerUserId))) : Promise.resolve([]),
      documentIds.length
        ? this.db.select().from(schema.documents).where(and(inArray(schema.documents.id, documentIds), eq(schema.documents.ownerUserId, person.ownerUserId)))
        : Promise.resolve([]),
      maintenanceIds.length
        ? this.db.select().from(schema.maintenanceRecords).where(and(inArray(schema.maintenanceRecords.id, maintenanceIds), eq(schema.maintenanceRecords.ownerUserId, person.ownerUserId)))
        : Promise.resolve([]),
      eventIds.length
        ? this.db.select().from(schema.calendarEvents).where(and(inArray(schema.calendarEvents.id, eventIds), eq(schema.calendarEvents.ownerUserId, person.ownerUserId)))
        : Promise.resolve([]),
      taskIds.length ? this.db.select().from(schema.tasks).where(and(inArray(schema.tasks.id, taskIds), eq(schema.tasks.ownerUserId, person.ownerUserId))) : Promise.resolve([]),
      warrantyIds.length
        ? this.db.select().from(schema.warranties).where(and(inArray(schema.warranties.id, warrantyIds), eq(schema.warranties.ownerUserId, person.ownerUserId)))
        : Promise.resolve([]),
      vehicleIds.length
        ? this.db.select().from(schema.vehicleProfiles).where(and(inArray(schema.vehicleProfiles.id, vehicleIds), eq(schema.vehicleProfiles.ownerUserId, person.ownerUserId)))
        : Promise.resolve([]),
      propertyIds.length
        ? this.db.select().from(schema.propertyProfiles).where(and(inArray(schema.propertyProfiles.id, propertyIds), eq(schema.propertyProfiles.ownerUserId, person.ownerUserId)))
        : Promise.resolve([]),
    ]);
    result.bill = bills;
    result.document = documents;
    result.maintenanceRecord = maintenance;
    result.calendarEvent = events;
    result.task = tasks;
    result.warranty = warranties;
    result.vehicle = vehicles;
    result.property = properties;
    return result;
  }

  async update(personId: string, userId: string, dto: UpdatePersonDto): Promise<void> {
    const person = await this.assertOwned(personId, userId);
    if (dto.organizationId) {
      const [organization] = await this.db.select().from(schema.organizations).where(eq(schema.organizations.id, dto.organizationId)).limit(1);
      if (!organization || organization.ownerUserId !== person.ownerUserId) throw new BadRequestException({ code: "INVALID_ORGANIZATION", message: "That organization isn't yours." });
    }
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.displayName !== undefined) updates.displayName = dto.displayName;
    if ("organizationId" in dto) updates.organizationId = dto.organizationId ?? null;
    if (dto.isImportant !== undefined) updates.isImportant = dto.isImportant;
    await this.db.update(schema.people).set(updates).where(eq(schema.people.id, personId));
  }

  async remove(personId: string, userId: string): Promise<void> {
    await this.assertOwned(personId, userId, "manage");
    await this.db.update(schema.people).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.people.id, personId));
  }

  /** PEO-001 "share contact" visibility toggle — owner-only, mirrors HealthLogisticsService.setAppointmentVisibility. */
  async setVisibility(personId: string, userId: string, visibility: "private" | "household"): Promise<void> {
    const [person] = await this.db.select().from(schema.people).where(eq(schema.people.id, personId)).limit(1);
    if (!person || person.deletedAt) throw new NotFoundException({ code: "PERSON_NOT_FOUND", message: "Person not found." });
    if (person.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your contact." });
    if (visibility === "household" && !person.householdId) {
      throw new BadRequestException({ code: "HOUSEHOLD_REQUIRED", message: "Add this person to a household before sharing it with your household." });
    }
    await this.db.update(schema.people).set({ visibility, updatedAt: new Date() }).where(eq(schema.people.id, personId));
  }

  /** PEO-003 "labels are user-editable" — sets a fresh label directly (first-time, edit, or overriding a
   * suggested one), always `relationshipLabelSource: "user_set"`. */
  async setRelationshipLabel(personId: string, userId: string, relationshipLabel: string): Promise<void> {
    await this.assertOwned(personId, userId);
    await this.db.update(schema.people).set({ relationshipLabel, relationshipLabelSource: "user_set", updatedAt: new Date() }).where(eq(schema.people.id, personId));
  }

  /** PEO-003 — confirms an existing "suggested" label as-is (no retyping), flipping it to "user_set". A
   * no-op error if there's nothing suggested to confirm, so a client can't silently promote a label the
   * user never actually saw as a suggestion. */
  async confirmSuggestedRelationshipLabel(personId: string, userId: string): Promise<void> {
    const person = await this.assertOwned(personId, userId);
    if (person.relationshipLabelSource !== "suggested" || !person.relationshipLabel) {
      throw new BadRequestException({ code: "NO_SUGGESTION", message: "There's no suggested label to confirm." });
    }
    await this.db.update(schema.people).set({ relationshipLabelSource: "user_set", updatedAt: new Date() }).where(eq(schema.people.id, personId));
  }

  async recordContact(personId: string, userId: string): Promise<void> {
    await this.assertOwned(personId, userId, "view");
    await this.db.update(schema.people).set({ lastContactAt: new Date(), updatedAt: new Date() }).where(eq(schema.people.id, personId));
  }

  // ---------------------------------------------------------------------------------------------------
  // Organizations
  // ---------------------------------------------------------------------------------------------------

  async listOrganizations(userId: string) {
    return this.db.select().from(schema.organizations).where(and(eq(schema.organizations.ownerUserId, userId), isNull(schema.organizations.deletedAt))).orderBy(asc(schema.organizations.name));
  }

  async createOrganization(userId: string, dto: CreateOrganizationDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    const id = generateId("organization");
    await this.db.insert(schema.organizations).values({ id, ownerUserId: userId, householdId: dto.householdId ?? null, name: dto.name, organizationType: dto.organizationType ?? null });
    return { id };
  }

  // ---------------------------------------------------------------------------------------------------
  // Aliases (PEO-002 identity-resolution evidence)
  // ---------------------------------------------------------------------------------------------------

  async addAlias(personId: string, userId: string, dto: AddAliasDto): Promise<{ id: string }> {
    const person = await this.assertOwned(personId, userId);
    const id = generateId("alias");
    await this.db.insert(schema.aliases).values({ id, personId, ownerUserId: person.ownerUserId, kind: dto.kind, value: dto.value });
    return { id };
  }

  async removeAlias(aliasId: string, userId: string): Promise<void> {
    const [alias] = await this.db.select().from(schema.aliases).where(eq(schema.aliases.id, aliasId)).limit(1);
    if (!alias) throw new NotFoundException({ code: "ALIAS_NOT_FOUND", message: "Not found." });
    await this.assertOwned(alias.personId, userId);
    await this.db.delete(schema.aliases).where(eq(schema.aliases.id, aliasId));
  }

  // ---------------------------------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------------------------------

  async addNote(personId: string, userId: string, dto: AddPersonNoteDto): Promise<{ id: string }> {
    const person = await this.assertOwned(personId, userId, "edit");
    const id = generateId("personNote");
    await this.db.insert(schema.personNotes).values({ id, personId, ownerUserId: person.ownerUserId, authorUserId: userId, body: dto.body });
    return { id };
  }

  async removeNote(noteId: string, userId: string): Promise<void> {
    const [note] = await this.db.select().from(schema.personNotes).where(eq(schema.personNotes.id, noteId)).limit(1);
    if (!note || note.deletedAt) throw new NotFoundException({ code: "NOTE_NOT_FOUND", message: "Not found." });
    if (note.authorUserId !== userId) await this.assertOwned(note.personId, userId, "manage");
    await this.db.update(schema.personNotes).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.personNotes.id, noteId));
  }

  // ---------------------------------------------------------------------------------------------------
  // Important dates (PEO-005)
  // ---------------------------------------------------------------------------------------------------

  async addImportantDate(personId: string, userId: string, dto: AddImportantDateDto): Promise<{ id: string }> {
    const person = await this.assertOwned(personId, userId);
    const date = dateOnly(dto.dateIso);
    const id = generateId("personImportantDate");
    await this.db.insert(schema.personImportantDates).values({
      id,
      personId,
      ownerUserId: person.ownerUserId,
      label: dto.label,
      date,
      dateSort: temporalToSortDate(date),
      isSensitive: dto.isSensitive ?? false,
      reminderDaysBefore: dto.reminderDaysBefore ?? 14,
    });
    return { id };
  }

  async removeImportantDate(dateId: string, userId: string): Promise<void> {
    const [row] = await this.db.select().from(schema.personImportantDates).where(eq(schema.personImportantDates.id, dateId)).limit(1);
    if (!row || row.deletedAt) throw new NotFoundException({ code: "IMPORTANT_DATE_NOT_FOUND", message: "Not found." });
    await this.assertOwned(row.personId, userId);
    await this.db.update(schema.personImportantDates).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.personImportantDates.id, dateId));
  }

  // ---------------------------------------------------------------------------------------------------
  // Relationships (PEO-003/PEO-004) — person-to-person or person-to-household-member.
  // ---------------------------------------------------------------------------------------------------

  async addRelationship(personId: string, userId: string, dto: AddPersonRelationshipDto): Promise<{ id: string }> {
    const person = await this.assertOwned(personId, userId);
    if (dto.toPersonId) {
      const target = await this.loadPerson(dto.toPersonId);
      if (target.ownerUserId !== person.ownerUserId) throw new BadRequestException({ code: "INVALID_TARGET", message: "That person isn't yours." });
    } else if (dto.toDependentProfileId) {
      const [dependent] = await this.db.select().from(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dto.toDependentProfileId)).limit(1);
      if (!dependent || (person.householdId && dependent.householdId !== person.householdId)) {
        throw new BadRequestException({ code: "INVALID_TARGET", message: "That household member isn't valid for this person." });
      }
    } else {
      throw new BadRequestException({ code: "INVALID_TARGET", message: "Provide a person or a household member." });
    }
    const id = generateId("personRelationship");
    await this.db.insert(schema.personRelationships).values({
      id,
      ownerUserId: person.ownerUserId,
      fromPersonId: personId,
      toPersonId: dto.toPersonId ?? null,
      toDependentProfileId: dto.toDependentProfileId ?? null,
      label: dto.label,
    });
    return { id };
  }

  async removeRelationship(relationshipId: string, userId: string): Promise<void> {
    const [row] = await this.db.select().from(schema.personRelationships).where(eq(schema.personRelationships.id, relationshipId)).limit(1);
    if (!row) throw new NotFoundException({ code: "RELATIONSHIP_NOT_FOUND", message: "Not found." });
    await this.assertOwned(row.fromPersonId, userId);
    await this.db.delete(schema.personRelationships).where(eq(schema.personRelationships.id, relationshipId));
  }

  // ---------------------------------------------------------------------------------------------------
  // PEO-004 generic related-entity linking — see people.relatedEntityIds' own schema doc comment.
  // ---------------------------------------------------------------------------------------------------

  async linkEntity(personId: string, userId: string, entityId: string): Promise<void> {
    const person = await this.assertOwned(personId, userId);
    const kind = LINKABLE_ENTITY_KINDS.find((k) => isIdOfKind(entityId, k));
    if (!kind) throw new BadRequestException({ code: "UNLINKABLE_ENTITY", message: "That kind of item can't be linked to a person." });
    await this.assertLinkableOwnership(kind, entityId, person.ownerUserId);
    if (person.relatedEntityIds.includes(entityId)) return;
    await this.db.update(schema.people).set({ relatedEntityIds: [...person.relatedEntityIds, entityId], updatedAt: new Date() }).where(eq(schema.people.id, personId));
  }

  async unlinkEntity(personId: string, userId: string, entityId: string): Promise<void> {
    const person = await this.assertOwned(personId, userId);
    await this.db
      .update(schema.people)
      .set({ relatedEntityIds: person.relatedEntityIds.filter((id) => id !== entityId), updatedAt: new Date() })
      .where(eq(schema.people.id, personId));
  }

  /** Confirms the target row actually belongs to the same owner before letting it be linked — otherwise
   * any authenticated user could point their own person at an arbitrary bill/document id they don't own and
   * read it back via GET /v1/people/:id, the same class of gap PetsService.assertOwnedOrAccessibleDocument
   * exists to close. */
  private async assertLinkableOwnership(kind: LinkableEntityKind, entityId: string, ownerUserId: string): Promise<void> {
    const table = {
      bill: schema.bills,
      document: schema.documents,
      maintenanceRecord: schema.maintenanceRecords,
      calendarEvent: schema.calendarEvents,
      task: schema.tasks,
      warranty: schema.warranties,
      vehicle: schema.vehicleProfiles,
      property: schema.propertyProfiles,
    }[kind];
    const [row] = await this.db.select({ ownerUserId: table.ownerUserId }).from(table).where(eq(table.id, entityId)).limit(1);
    if (!row || row.ownerUserId !== ownerUserId) throw new BadRequestException({ code: "NOT_YOUR_ITEM", message: "That item isn't yours to link." });
  }

  // ---------------------------------------------------------------------------------------------------
  // PEO-002 identity resolution — merge candidates + reversible merge/unmerge.
  // ---------------------------------------------------------------------------------------------------

  /**
   * Precision-first candidate surfacing, never an automatic merge (PEO-002 "ambiguous merges require
   * review"). Mirrors AdminService.findDuplicateMerchantCandidates' own shape: loads this owner's active
   * people + their aliases (already decrypted by drizzle's encryptedText custom type on select), then
   * groups in application code by normalized email, normalized phone, and (normalized name + organization)
   * — three independent, high-precision signals rather than one fuzzy score, so a candidate group always
   * comes with a concrete, explainable reason a human can verify at a glance.
   */
  async findMergeCandidates(userId: string) {
    const people = await this.db
      .select()
      .from(schema.people)
      .where(and(eq(schema.people.ownerUserId, userId), isNull(schema.people.deletedAt), isNull(schema.people.mergedIntoPersonId)));
    if (people.length < 2) return [];
    const peopleIds = people.map((p) => p.id);
    const allAliases = await this.db.select().from(schema.aliases).where(inArray(schema.aliases.personId, peopleIds));
    const aliasesByPerson = new Map<string, (typeof allAliases)[number][]>();
    for (const alias of allAliases) {
      const list = aliasesByPerson.get(alias.personId) ?? [];
      list.push(alias);
      aliasesByPerson.set(alias.personId, list);
    }

    const emailGroups = new Map<string, Set<string>>();
    const phoneGroups = new Map<string, Set<string>>();
    for (const person of people) {
      for (const alias of aliasesByPerson.get(person.id) ?? []) {
        const bucket = alias.kind === "email" ? emailGroups : alias.kind === "phone" ? phoneGroups : null;
        if (!bucket) continue;
        const key = alias.kind === "email" ? normalizeEmail(alias.value) : normalizePhone(alias.value);
        if (!key) continue;
        if (!bucket.has(key)) bucket.set(key, new Set());
        bucket.get(key)!.add(person.id);
      }
    }
    const nameOrgGroups = new Map<string, Set<string>>();
    for (const person of people) {
      const key = `${normalizeName(person.displayName)}::${person.organizationId ?? ""}`;
      if (!nameOrgGroups.has(key)) nameOrgGroups.set(key, new Set());
      nameOrgGroups.get(key)!.add(person.id);
    }

    const peopleById = new Map(people.map((p) => [p.id, p] as const));
    const candidates: { reason: "matching_email" | "matching_phone" | "matching_name_and_organization"; personIds: string[]; people: (typeof people)[number][] }[] = [];
    const pushGroups = (groups: Map<string, Set<string>>, reason: (typeof candidates)[number]["reason"]) => {
      for (const idSet of groups.values()) {
        if (idSet.size < 2) continue;
        const ids = [...idSet];
        candidates.push({ reason, personIds: ids, people: ids.map((id) => peopleById.get(id)!) });
      }
    };
    pushGroups(emailGroups, "matching_email");
    pushGroups(phoneGroups, "matching_phone");
    pushGroups(nameOrgGroups, "matching_name_and_organization");
    return candidates;
  }

  /**
   * Reversible merge (PEO-002 "Merge operations are reversible and preserve source mappings") — mirrors
   * AdminService.mergeMerchants' snapshot+repoint+lineage shape exactly, adapted to this domain's five
   * satellite tables (contactSources/aliases/notes/importantDates/relationships) instead of merchants'
   * three. Both people must be owned by the SAME caller — unlike merchant merges (an admin-only operation
   * over a shared global catalog), a person merge is an ordinary user action over their own contacts, so
   * ownership (not an admin role) is the authorization boundary here.
   */
  async mergePeople(survivingPersonId: string, mergedPersonId: string, actorUserId: string) {
    if (survivingPersonId === mergedPersonId) {
      throw new BadRequestException({ code: "SAME_PERSON", message: "Can't merge a person into themselves." });
    }
    const [surviving] = await this.db.select().from(schema.people).where(eq(schema.people.id, survivingPersonId)).limit(1);
    const [merged] = await this.db.select().from(schema.people).where(eq(schema.people.id, mergedPersonId)).limit(1);
    if (!surviving || !merged || surviving.deletedAt || merged.deletedAt) {
      throw new NotFoundException({ code: "PERSON_NOT_FOUND", message: "One or both people were not found." });
    }
    if (surviving.ownerUserId !== actorUserId || merged.ownerUserId !== actorUserId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only merge your own contacts." });
    }
    if (merged.mergedIntoPersonId) throw new BadRequestException({ code: "ALREADY_MERGED", message: "That person was already merged into another one." });

    const lineageId = generateId("personMergeLineage");
    const repointed = await this.db.transaction(async (tx) => {
      const [contactSourceRows, aliasRows, noteRows, dateRows, relFromRows, relToRows] = await Promise.all([
        tx.select({ id: schema.contactSources.id }).from(schema.contactSources).where(eq(schema.contactSources.personId, mergedPersonId)),
        tx.select({ id: schema.aliases.id }).from(schema.aliases).where(eq(schema.aliases.personId, mergedPersonId)),
        tx.select({ id: schema.personNotes.id }).from(schema.personNotes).where(eq(schema.personNotes.personId, mergedPersonId)),
        tx.select({ id: schema.personImportantDates.id }).from(schema.personImportantDates).where(eq(schema.personImportantDates.personId, mergedPersonId)),
        tx.select({ id: schema.personRelationships.id }).from(schema.personRelationships).where(eq(schema.personRelationships.fromPersonId, mergedPersonId)),
        tx.select({ id: schema.personRelationships.id }).from(schema.personRelationships).where(eq(schema.personRelationships.toPersonId, mergedPersonId)),
      ]);
      const contactSourceIds = contactSourceRows.map((r) => r.id);
      const aliasIds = aliasRows.map((r) => r.id);
      const noteIds = noteRows.map((r) => r.id);
      const importantDateIds = dateRows.map((r) => r.id);
      const relationshipIds = [...relFromRows.map((r) => r.id), ...relToRows.map((r) => r.id)];

      await tx.update(schema.contactSources).set({ personId: survivingPersonId }).where(eq(schema.contactSources.personId, mergedPersonId));
      await tx.update(schema.aliases).set({ personId: survivingPersonId }).where(eq(schema.aliases.personId, mergedPersonId));
      await tx.update(schema.personNotes).set({ personId: survivingPersonId }).where(eq(schema.personNotes.personId, mergedPersonId));
      await tx.update(schema.personImportantDates).set({ personId: survivingPersonId }).where(eq(schema.personImportantDates.personId, mergedPersonId));
      await tx.update(schema.personRelationships).set({ fromPersonId: survivingPersonId }).where(eq(schema.personRelationships.fromPersonId, mergedPersonId));
      await tx.update(schema.personRelationships).set({ toPersonId: survivingPersonId }).where(eq(schema.personRelationships.toPersonId, mergedPersonId));
      // PEO-004 — carry the merged person's own relatedEntityIds/isImportant/lastContactAt onto the
      // survivor too, deduped, so linked history isn't silently dropped by the merge.
      const mergedRelated = merged.relatedEntityIds.filter((id) => !surviving.relatedEntityIds.includes(id));
      await tx
        .update(schema.people)
        .set({
          relatedEntityIds: [...surviving.relatedEntityIds, ...mergedRelated],
          isImportant: surviving.isImportant || merged.isImportant,
          lastContactAt:
            surviving.lastContactAt && merged.lastContactAt
              ? (surviving.lastContactAt > merged.lastContactAt ? surviving.lastContactAt : merged.lastContactAt)
              : (surviving.lastContactAt ?? merged.lastContactAt),
          updatedAt: new Date(),
        })
        .where(eq(schema.people.id, survivingPersonId));
      await tx.update(schema.people).set({ mergedIntoPersonId: survivingPersonId, updatedAt: new Date() }).where(eq(schema.people.id, mergedPersonId));

      await tx.insert(schema.personMergeLineage).values({
        id: lineageId,
        survivingPersonId,
        mergedPersonId,
        mergedPersonSnapshot: merged,
        repointedContactSourceIds: contactSourceIds,
        repointedAliasIds: aliasIds,
        repointedNoteIds: noteIds,
        repointedImportantDateIds: importantDateIds,
        repointedRelationshipIds: relationshipIds,
        actorUserId,
      });

      return { contactSourceIds, aliasIds, noteIds, importantDateIds, relationshipIds };
    });

    return {
      lineageId,
      repointedContactSourceCount: repointed.contactSourceIds.length,
      repointedAliasCount: repointed.aliasIds.length,
      repointedNoteCount: repointed.noteIds.length,
      repointedImportantDateCount: repointed.importantDateIds.length,
      repointedRelationshipCount: repointed.relationshipIds.length,
    };
  }

  async listMergeLineage(userId: string) {
    const surviving = this.db
      .select()
      .from(schema.personMergeLineage)
      .innerJoin(schema.people, eq(schema.people.id, schema.personMergeLineage.survivingPersonId))
      .where(eq(schema.people.ownerUserId, userId))
      .orderBy(desc(schema.personMergeLineage.mergedAt));
    return surviving;
  }

  /** Reverses exactly one merge: restores the merged person row and repoints only the rows THAT merge
   * actually moved (mirrors AdminService.unmergeMerchants). */
  async unmergePeople(lineageId: string, actorUserId: string) {
    const [lineage] = await this.db.select().from(schema.personMergeLineage).where(eq(schema.personMergeLineage.id, lineageId)).limit(1);
    if (!lineage) throw new NotFoundException({ code: "MERGE_NOT_FOUND", message: "That merge record was not found." });
    if (lineage.unmergedAt) throw new BadRequestException({ code: "ALREADY_UNMERGED", message: "That merge was already undone." });
    if (lineage.actorUserId !== actorUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only undo your own merges." });

    await this.db.transaction(async (tx) => {
      await tx.update(schema.people).set({ mergedIntoPersonId: null, updatedAt: new Date() }).where(eq(schema.people.id, lineage.mergedPersonId));

      if (lineage.repointedContactSourceIds.length > 0) {
        await tx.update(schema.contactSources).set({ personId: lineage.mergedPersonId }).where(inArray(schema.contactSources.id, lineage.repointedContactSourceIds));
      }
      if (lineage.repointedAliasIds.length > 0) {
        await tx.update(schema.aliases).set({ personId: lineage.mergedPersonId }).where(inArray(schema.aliases.id, lineage.repointedAliasIds));
      }
      if (lineage.repointedNoteIds.length > 0) {
        await tx.update(schema.personNotes).set({ personId: lineage.mergedPersonId }).where(inArray(schema.personNotes.id, lineage.repointedNoteIds));
      }
      if (lineage.repointedImportantDateIds.length > 0) {
        await tx.update(schema.personImportantDates).set({ personId: lineage.mergedPersonId }).where(inArray(schema.personImportantDates.id, lineage.repointedImportantDateIds));
      }
      if (lineage.repointedRelationshipIds.length > 0) {
        // Repointed either direction at merge time — restore whichever side actually pointed at
        // survivingPersonId back to mergedPersonId, leaving any OTHER relationship genuinely about the
        // survivor untouched.
        await tx
          .update(schema.personRelationships)
          .set({ fromPersonId: lineage.mergedPersonId })
          .where(and(inArray(schema.personRelationships.id, lineage.repointedRelationshipIds), eq(schema.personRelationships.fromPersonId, lineage.survivingPersonId)));
        await tx
          .update(schema.personRelationships)
          .set({ toPersonId: lineage.mergedPersonId })
          .where(and(inArray(schema.personRelationships.id, lineage.repointedRelationshipIds), eq(schema.personRelationships.toPersonId, lineage.survivingPersonId)));
      }

      await tx.update(schema.personMergeLineage).set({ unmergedAt: new Date() }).where(eq(schema.personMergeLineage.id, lineageId));
    });

    return {
      restoredContactSourceCount: lineage.repointedContactSourceIds.length,
      restoredAliasCount: lineage.repointedAliasIds.length,
      restoredNoteCount: lineage.repointedNoteIds.length,
      restoredImportantDateCount: lineage.repointedImportantDateIds.length,
      restoredRelationshipCount: lineage.repointedRelationshipIds.length,
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) — mirrors PetsService's sharing endpoints,
  // resourceType "person". PEO-001 "share contact" user action.
  // ---------------------------------------------------------------------------------------------------

  private async assertOwnedOrManagedForSharing(personId: string, userId: string) {
    const person = await this.loadPerson(personId);
    if (person.ownerUserId === userId) return person;
    if (await this.sharing.hasGrantAtLeast("person", personId, userId, "manage")) return person;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or a manager can share this person." });
  }

  async createGrant(personId: string, requestingUserId: string, granteeEmail: string, expiresInDays?: number, right: ResourceGrantRight = "view", message?: string) {
    await this.assertOwnedOrManagedForSharing(personId, requestingUserId);
    return this.sharing.createResourceGrant("person", personId, requestingUserId, granteeEmail, expiresInDays, right, message);
  }

  async listGrants(personId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedForSharing(personId, requestingUserId);
    return this.sharing.listResourceGrants("person", personId);
  }

  async revokeGrant(grantId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "person") return false;
      return this.sharing.hasGrantAtLeast("person", resourceId, requestingUserId, "manage");
    });
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAccessEvents(personId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedForSharing(personId, requestingUserId);
    return this.sharing.listAccessEvents("person", personId);
  }
}
