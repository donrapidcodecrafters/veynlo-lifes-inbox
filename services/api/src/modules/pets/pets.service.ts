import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import type { CreateShareLinkDto, ResourceGrantRight } from "../sharing/dto";
import { SearchIndexService } from "../search/search-index.service";
import type { CreatePetProfileDto, UpdatePetProfileDto, CreatePetVaccinationDto, CreateRefillReminderDto } from "./dto";

function dateOnly(iso: string | null | undefined): TemporalValue | null {
  if (!iso) return null;
  return { precision: "date", instantUtc: null, date: iso.slice(0, 10), timezone: null, sourceText: null };
}

/** Mirrors PeopleService's own normalizeName exactly — trim/lowercase/strip non-alphanumerics, so
 * formatting differences ("Rex" vs "rex ") don't block a match but two genuinely different names never do. */
function normalizePetLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** §40.1's entity-resolution table has no row for pets — the spec only names Person/Purchase/Shipment/
 * Subscription/Vehicle/Property/Document/Trip. Pets have no VIN- or order-ID-equivalent unique identifier
 * (a microchip number would be the closest analog, but it's frequently never on file — PET-001 doesn't
 * require it), so this key is a judgment call rather than a spec-mandated one: exact normalized name +
 * exact household (or exact owner, for a pet with no household) + exact species. All three must match —
 * two same-named pets of DIFFERENT species (a cat "Charlie" and a dog "Charlie" in the same household) are
 * never offered as a candidate, the same precision-first "false non-merge is preferable" bar §40.2 states
 * for every other entity type. Breed is deliberately NOT part of the key: a breed correction/typo
 * ("Lab" vs "Labrador") shouldn't block an otherwise-exact name+species+household match the way a
 * genuinely different species must. */
function petMergeKey(pet: { label: string; species: string | null; householdId: string | null; ownerUserId: string }): string {
  return `${normalizePetLabel(pet.label)}::${pet.householdId ?? pet.ownerUserId}::${(pet.species ?? "").trim().toLowerCase()}`;
}

/**
 * PET-001..PET-005 (spec ch.28 "Pets") — a household-owned Pet entity. Structurally mirrors
 * AssetsService (property/vehicle profiles) closely on purpose: same `ownerOrDelegatedHousehold`
 * shape (reuses the `commerce:read` delegation scope, exactly like AssetsService's own doc comment
 * explains for why a property/vehicle-adjacent feature doesn't need its own delegation scope), same
 * sharing-endpoint shape via SharingService, same soft-delete-by-owner pattern. Kept as its own module
 * rather than folded into AssetsModule because pets have sub-resources (vaccinations, refill reminders)
 * vehicles/properties don't — see `petVaccinations`/`refillReminders`' own schema doc comments.
 */
@Injectable()
export class PetsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    // §44.4 "Search architecture" wiring — optional/trailing so every existing positional
    // `new PetsService(...)` test construction keeps compiling unchanged.
    @Inject(SearchIndexService) private readonly searchIndex?: SearchIndexService,
  ) {}

  // Identical shape to AssetsService.ownerOrDelegatedHousehold — see its own doc comment for why plain
  // active membership is OR'd in alongside delegation.
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "commerce:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  async list(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("pet", userId);
    const baseCondition = await this.ownerOrDelegatedHousehold(userId, schema.petProfiles.ownerUserId, schema.petProfiles.householdId);
    const accessCondition = grantedIds.length > 0 ? or(baseCondition, inArray(schema.petProfiles.id, grantedIds))! : baseCondition;
    return this.db
      .select()
      .from(schema.petProfiles)
      // §40.2 — a merged-away pet (mergedIntoPetId set) is excluded from ordinary list queries, same as
      // deletedAt, but never hard-deleted — see mergePets' own doc comment.
      .where(and(isNull(schema.petProfiles.deletedAt), isNull(schema.petProfiles.mergedIntoPetId), accessCondition))
      .orderBy(asc(schema.petProfiles.label));
  }

  async create(userId: string, dto: CreatePetProfileDto): Promise<{ id: string }> {
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const id = generateId("pet");
    await this.db.insert(schema.petProfiles).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      label: dto.label,
      species: dto.species ?? null,
      breed: dto.breed ?? null,
      birthDate: dateOnly(dto.birthDateIso),
      microchipNumber: dto.microchipNumber ?? null,
      vetProviderName: dto.vetProviderName ?? null,
      insuranceProviderName: dto.insuranceProviderName ?? null,
      insurancePolicyNumber: dto.insurancePolicyNumber ?? null,
    });
    // §44.4 — "sensitive" default matches petProfiles.sensitivity's own schema default; nothing in this
    // service ever varies it away from that default (see search-index.service.ts's own doc comment).
    await this.searchIndex?.upsert({
      resourceType: "pet",
      resourceId: id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      sensitivity: "sensitive",
      title: dto.label,
      bodyText: [dto.species, dto.breed].filter(Boolean).join(" "),
    });
    return { id };
  }

  async detail(petId: string, userId: string) {
    const [pet] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    if (!pet || pet.deletedAt || pet.mergedIntoPetId) return null;
    await this.assertPetAccess(pet.ownerUserId, pet.householdId, userId, { resourceType: "pet", resourceId: petId });
    // SHARE-001 "optional message" — same reasoning as ListsService.listDetail.
    const sharedNote = (await this.isOwnerOrHousehold(pet.ownerUserId, pet.householdId, userId)) ? null : await this.sharing.grantMessage("pet", petId, userId);
    const [vaccinationRows, maintenance, refillReminders, bills] = await Promise.all([
      this.db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.petProfileId, petId)).orderBy(desc(schema.petVaccinations.expirationDateSort)),
      this.db
        .select()
        .from(schema.maintenanceRecords)
        .where(eq(schema.maintenanceRecords.petProfileId, petId))
        .orderBy(desc(schema.maintenanceRecords.serviceDateSort)),
      this.db.select().from(schema.refillReminders).where(eq(schema.refillReminders.petProfileId, petId)).orderBy(asc(schema.refillReminders.nextRefillDateSort)),
      this.db.select().from(schema.bills).where(eq(schema.bills.petProfileId, petId)).orderBy(desc(schema.bills.dueDateSort)),
    ]);
    // AI-001 "Evidence-backed fact creation" — petVaccinations.sourceEventId was populated for every
    // evidence_sourced row (extractPetVaccination) since that extractor shipped, but nothing ever read it
    // back, the identical gap this session's health-appointment evidence fix closed. Mirrors
    // HealthLogisticsService.evidenceForSourceEvent exactly.
    const vaccinations = await Promise.all(
      vaccinationRows.map(async (vaccination) => ({ ...vaccination, evidence: await this.evidenceForSourceEvent(vaccination.sourceEventId) })),
    );
    return { pet, vaccinations, maintenance, refillReminders, bills, sharedNote };
  }

  /** Mirrors HealthLogisticsService.evidenceForSourceEvent/CommerceService.evidenceForSourceEvent exactly
   * (§39.2/AI-001 "why am I seeing this?") — `source_events` deliberately never stores the full body, only
   * what was captured at ingest time. */
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

  /** See UpdatePetProfileDtoSchema's own doc comment for the `householdId` assign-after-the-fact gap this
   * closes. Reassigning to a NEW household requires the caller to actually be an active member of it —
   * same check `create` itself already makes — so this can't silently move someone else's pet into a
   * household the caller doesn't belong to. */
  async update(petId: string, userId: string, dto: UpdatePetProfileDto): Promise<void> {
    const pet = await this.assertOwnedOrManagedPet(petId, userId);
    if (dto.photoDocumentId) await this.assertOwnedOrAccessibleDocument(dto.photoDocumentId, pet.ownerUserId, pet.householdId, userId);
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if ("label" in dto && dto.label !== undefined) updates.label = dto.label;
    if ("species" in dto) updates.species = dto.species ?? null;
    if ("breed" in dto) updates.breed = dto.breed ?? null;
    if ("birthDateIso" in dto) updates.birthDate = dateOnly(dto.birthDateIso);
    if ("microchipNumber" in dto) updates.microchipNumber = dto.microchipNumber ?? null;
    if ("photoDocumentId" in dto) updates.photoDocumentId = dto.photoDocumentId ?? null;
    if ("vetProviderName" in dto) updates.vetProviderName = dto.vetProviderName ?? null;
    if ("insuranceProviderName" in dto) updates.insuranceProviderName = dto.insuranceProviderName ?? null;
    if ("insurancePolicyNumber" in dto) updates.insurancePolicyNumber = dto.insurancePolicyNumber ?? null;
    if ("lifecycleStatus" in dto && dto.lifecycleStatus) updates.lifecycleStatus = dto.lifecycleStatus;
    if ("householdId" in dto) updates.householdId = dto.householdId ?? null;
    await this.db.update(schema.petProfiles).set(updates).where(eq(schema.petProfiles.id, petId));
    // "householdId" is included here too — the search index's own row carries householdId for its own
    // visibility scoping, and leaving it stale after a household reassignment would leave this pet
    // findable by the WRONG household's members (or invisible to the right one) until some unrelated field
    // happened to change and refresh it.
    if ("label" in dto || "species" in dto || "breed" in dto || "householdId" in dto) {
      const label = "label" in dto && dto.label !== undefined ? dto.label : pet.label;
      const species = "species" in dto ? (dto.species ?? null) : pet.species;
      const breed = "breed" in dto ? (dto.breed ?? null) : pet.breed;
      const householdId = "householdId" in dto ? (dto.householdId ?? null) : pet.householdId;
      await this.searchIndex?.upsert({
        resourceType: "pet",
        resourceId: petId,
        ownerUserId: pet.ownerUserId,
        householdId,
        sensitivity: "sensitive",
        title: label,
        bodyText: [species, breed].filter(Boolean).join(" "),
      });
    }
  }

  /** SHARE-001 "manage = edit + delete" — deleting the pet itself needs "manage" from a grantee (household
   * managers/owners are unaffected — see assertOwnedOrManagedPet's own doc comment). */
  async remove(petId: string, userId: string): Promise<void> {
    await this.assertOwnedOrManagedPet(petId, userId, "manage");
    await this.db.update(schema.petProfiles).set({ deletedAt: new Date() }).where(eq(schema.petProfiles.id, petId));
    await this.searchIndex?.markDeleted("pet", petId);
  }

  // --- Vaccinations (PET-004) ------------------------------------------------------------------------

  async addVaccination(petId: string, userId: string, dto: CreatePetVaccinationDto): Promise<{ id: string }> {
    const pet = await this.assertPetOrHouseholdAccess(petId, userId);
    if (dto.documentId) await this.assertOwnedOrAccessibleDocument(dto.documentId, pet.ownerUserId, pet.householdId, userId);
    const expirationDate = dateOnly(dto.expirationDateIso);
    const id = generateId("petVaccination");
    await this.db.insert(schema.petVaccinations).values({
      id,
      ownerUserId: userId,
      householdId: pet.householdId,
      petProfileId: petId,
      label: dto.label,
      documentId: dto.documentId ?? null,
      expirationDate,
      expirationDateSort: expirationDate?.date ? new Date(`${expirationDate.date}T00:00:00Z`) : null,
      // PET-004 "Deadline must be sourced/user-confirmed" — a row created through this manual endpoint is
      // by definition user-confirmed (the user just typed/selected it); the "evidence_sourced" value is
      // only ever set by ingestion's extractPetVaccination for an AI-discovered candidate awaiting the
      // normal inbox confirm/correct/dismiss flow.
      source: "user_confirmed",
      confidenceBand: "verified",
    });
    return { id };
  }

  /** Unassigned vaccination candidates (petProfileId null) for every household the user belongs to, plus
   * any they own directly — the "let the user assign" other half of extractPetVaccination's conservative
   * multi-pet matching (see petVaccinations' own schema doc comment). */
  async unassignedVaccinations(userId: string) {
    const householdIds = await this.households.activeHouseholdIds(userId);
    const condition =
      householdIds.length > 0
        ? or(eq(schema.petVaccinations.ownerUserId, userId), inArray(schema.petVaccinations.householdId, householdIds))!
        : eq(schema.petVaccinations.ownerUserId, userId);
    return this.db.select().from(schema.petVaccinations).where(and(isNull(schema.petVaccinations.petProfileId), condition));
  }

  /** Assigns a previously-unassigned (or reassigns any) vaccination candidate to a specific pet — the
   * counterpart to extractPetVaccination filing one with `petProfileId: null` when it couldn't confidently
   * tell which household pet an email was about. */
  async assignVaccination(vaccinationId: string, petId: string, userId: string): Promise<void> {
    const [vaccination] = await this.db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.id, vaccinationId)).limit(1);
    if (!vaccination) throw new NotFoundException({ code: "PET_VACCINATION_NOT_FOUND", message: "Vaccination record not found." });
    await this.assertPetOrHouseholdAccess(petId, userId);
    if (vaccination.ownerUserId !== userId) {
      const householdIds = vaccination.householdId ? await this.households.activeHouseholdIds(userId) : [];
      if (!vaccination.householdId || !householdIds.includes(vaccination.householdId)) {
        throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
      }
    }
    await this.db.update(schema.petVaccinations).set({ petProfileId: petId, updatedAt: new Date() }).where(eq(schema.petVaccinations.id, vaccinationId));
  }

  /**
   * PET-002 — the counterpart to extractPetEvent filing a vet/grooming event with `relatedEntityIds: []`
   * when it couldn't confidently tell which household pet an email was about (same conservative matching
   * discipline as assignVaccination above). Only touches `relatedEntityIds`/`source` on a calendar event
   * that's actually tagged `source: "pet"` — this must never let a caller repurpose an unrelated calendar
   * event into looking pet-linked.
   */
  async assignEvent(eventId: string, petId: string, userId: string): Promise<void> {
    const [event] = await this.db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)).limit(1);
    if (!event || event.source !== "pet") throw new NotFoundException({ code: "EVENT_NOT_FOUND", message: "Pet event not found." });
    await this.assertPetOrHouseholdAccess(petId, userId);
    if (event.ownerUserId !== userId) {
      const householdIds = event.householdId ? await this.households.activeHouseholdIds(userId) : [];
      if (!event.householdId || !householdIds.includes(event.householdId)) {
        throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
      }
    }
    await this.db.update(schema.calendarEvents).set({ relatedEntityIds: [petId], updatedAt: new Date() }).where(eq(schema.calendarEvents.id, eventId));
  }

  // --- Refill reminders (PET-003) ---------------------------------------------------------------------
  // See refillReminders' own schema doc comment for why this table isn't named pet-specifically.

  async addRefillReminder(petId: string, userId: string, dto: CreateRefillReminderDto): Promise<{ id: string }> {
    const pet = await this.assertPetOrHouseholdAccess(petId, userId);
    const nextRefillDate = dateOnly(dto.nextRefillDateIso)!;
    const id = generateId("refillReminder");
    await this.db.insert(schema.refillReminders).values({
      id,
      ownerUserId: userId,
      householdId: pet.householdId,
      petProfileId: petId,
      medicationName: dto.medicationName,
      nextRefillDate,
      nextRefillDateSort: nextRefillDate.date ? new Date(`${nextRefillDate.date}T00:00:00Z`) : null,
      pharmacy: dto.pharmacy ?? null,
      notes: dto.notes ?? null,
    });
    return { id };
  }

  /** HLTH-003 "mark picked up" — same semantics/column as the Health Logistics side of this shared table
   * (see refillReminders.pickedUpAt's own schema doc comment); stops AttentionService's deadline scan from
   * continuing to surface a refill the user already collected. */
  async markRefillPickedUp(reminderId: string, userId: string): Promise<void> {
    const reminder = await this.loadOwnedRefillReminder(reminderId, userId);
    await this.db.update(schema.refillReminders).set({ pickedUpAt: new Date(), updatedAt: new Date() }).where(eq(schema.refillReminders.id, reminder.id));
  }

  async markRefillHandled(reminderId: string, userId: string, nextRefillDateIso: string): Promise<void> {
    const reminder = await this.loadOwnedRefillReminder(reminderId, userId);
    const nextRefillDate = dateOnly(nextRefillDateIso)!;
    await this.db
      .update(schema.refillReminders)
      .set({
        nextRefillDate,
        nextRefillDateSort: nextRefillDate.date ? new Date(`${nextRefillDate.date}T00:00:00Z`) : null,
        // A new cycle starts unhandled — pickedUpAt describes the CURRENT refill window, not the reminder
        // row's whole lifetime, so rolling the date forward clears it rather than leaving a stale flag
        // that would make the new window look already handled.
        pickedUpAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.refillReminders.id, reminder.id));
  }

  /** Only a pet-scoped reminder (petProfileId set) is this module's concern — the same table's
   * dependent-scoped rows (`dependentProfileId` set) belong to Health Logistics; this pet-only guard keeps
   * that ownership boundary from either module reaching into the other's rows through this shared endpoint
   * surface. */
  private async loadOwnedRefillReminder(reminderId: string, userId: string) {
    const [reminder] = await this.db.select().from(schema.refillReminders).where(eq(schema.refillReminders.id, reminderId)).limit(1);
    if (!reminder || reminder.deletedAt) throw new NotFoundException({ code: "REFILL_REMINDER_NOT_FOUND", message: "Refill reminder not found." });
    // This module only ever acts on a pet-scoped row (petProfileId set) — a dependentProfileId-scoped row
    // belongs to Health Logistics and must be rejected here even if the requesting user happens to own it,
    // otherwise a human family member's medication reminder would be reachable through the pets endpoint
    // surface (see this method's own doc comment and pets.controller.ts's route-naming comment).
    if (!reminder.petProfileId) throw new NotFoundException({ code: "REFILL_REMINDER_NOT_FOUND", message: "Refill reminder not found." });
    await this.assertPetOrHouseholdAccess(reminder.petProfileId, userId);
    return reminder;
  }

  // ---------------------------------------------------------------------------------------------------
  // §40.1/40.2 identity resolution — pet merge candidates + reversible merge/unmerge. Mirrors
  // PeopleService's PEO-002 section shape exactly (see its own class-level doc comment and petMergeKey's
  // own doc comment above for the precision-first key used here in place of a spec-mandated one).
  // ---------------------------------------------------------------------------------------------------

  async findPetMergeCandidates(userId: string) {
    const pets = await this.db
      .select()
      .from(schema.petProfiles)
      .where(and(eq(schema.petProfiles.ownerUserId, userId), isNull(schema.petProfiles.deletedAt), isNull(schema.petProfiles.mergedIntoPetId)));
    if (pets.length < 2) return [];
    const groups = new Map<string, typeof pets>();
    for (const pet of pets) {
      const key = petMergeKey(pet);
      const group = groups.get(key);
      if (group) group.push(pet);
      else groups.set(key, [pet]);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((pets) => ({ reason: "matching_name_household_and_species" as const, petIds: pets.map((p) => p.id), pets }));
  }

  async listPetMergeLineage(userId: string) {
    return this.db
      .select()
      .from(schema.petMergeLineage)
      .innerJoin(schema.petProfiles, eq(schema.petProfiles.id, schema.petMergeLineage.survivingPetId))
      .where(eq(schema.petProfiles.ownerUserId, userId))
      .orderBy(desc(schema.petMergeLineage.mergedAt));
  }

  /**
   * Reversible merge (§40.2) — mirrors PeopleService.mergePeople's snapshot+repoint+lineage shape exactly,
   * adapted to this domain's four satellite tables (petVaccinations/refillReminders/maintenanceRecords/
   * bills). Also combines the merged pet's own on-profile fields (microchip/vet/insurance info) onto the
   * survivor — but only to fill a gap, never to overwrite a value the survivor already has, same
   * "user correction always outranks a guess" discipline VinDecodeService/AssetsService.mergeVehicles apply.
   * That field-fill is deliberately one-way (unmergePets doesn't revert it), mirroring
   * PeopleService.mergePeople's own identical treatment of isImportant/lastContactAt/relatedEntityIds.
   */
  async mergePets(survivingPetId: string, mergedPetId: string, actorUserId: string) {
    if (survivingPetId === mergedPetId) {
      throw new BadRequestException({ code: "SAME_PET", message: "Can't merge a pet into itself." });
    }
    const [surviving] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, survivingPetId)).limit(1);
    const [merged] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, mergedPetId)).limit(1);
    if (!surviving || !merged || surviving.deletedAt || merged.deletedAt) {
      throw new NotFoundException({ code: "PET_NOT_FOUND", message: "One or both pets were not found." });
    }
    if (surviving.ownerUserId !== actorUserId || merged.ownerUserId !== actorUserId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only merge your own pets." });
    }
    if (merged.mergedIntoPetId) throw new BadRequestException({ code: "ALREADY_MERGED", message: "That pet was already merged into another one." });

    const lineageId = generateId("petMergeLineage");
    const repointed = await this.db.transaction(async (tx) => {
      const [vaccinationRows, refillRows, maintenanceRows, billRows] = await Promise.all([
        tx.select({ id: schema.petVaccinations.id }).from(schema.petVaccinations).where(eq(schema.petVaccinations.petProfileId, mergedPetId)),
        tx.select({ id: schema.refillReminders.id }).from(schema.refillReminders).where(eq(schema.refillReminders.petProfileId, mergedPetId)),
        tx.select({ id: schema.maintenanceRecords.id }).from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.petProfileId, mergedPetId)),
        tx.select({ id: schema.bills.id }).from(schema.bills).where(eq(schema.bills.petProfileId, mergedPetId)),
      ]);
      const vaccinationIds = vaccinationRows.map((r) => r.id);
      const refillReminderIds = refillRows.map((r) => r.id);
      const maintenanceRecordIds = maintenanceRows.map((r) => r.id);
      const billIds = billRows.map((r) => r.id);

      await tx.update(schema.petVaccinations).set({ petProfileId: survivingPetId }).where(eq(schema.petVaccinations.petProfileId, mergedPetId));
      await tx.update(schema.refillReminders).set({ petProfileId: survivingPetId }).where(eq(schema.refillReminders.petProfileId, mergedPetId));
      await tx.update(schema.maintenanceRecords).set({ petProfileId: survivingPetId }).where(eq(schema.maintenanceRecords.petProfileId, mergedPetId));
      await tx.update(schema.bills).set({ petProfileId: survivingPetId }).where(eq(schema.bills.petProfileId, mergedPetId));
      await tx
        .update(schema.petProfiles)
        .set({
          microchipNumber: surviving.microchipNumber ?? merged.microchipNumber,
          vetProviderName: surviving.vetProviderName ?? merged.vetProviderName,
          insuranceProviderName: surviving.insuranceProviderName ?? merged.insuranceProviderName,
          insurancePolicyNumber: surviving.insurancePolicyNumber ?? merged.insurancePolicyNumber,
          breed: surviving.breed ?? merged.breed,
          updatedAt: new Date(),
        })
        .where(eq(schema.petProfiles.id, survivingPetId));
      await tx.update(schema.petProfiles).set({ mergedIntoPetId: survivingPetId, updatedAt: new Date() }).where(eq(schema.petProfiles.id, mergedPetId));

      await tx.insert(schema.petMergeLineage).values({
        id: lineageId,
        survivingPetId,
        mergedPetId,
        mergedPetSnapshot: merged,
        repointedVaccinationIds: vaccinationIds,
        repointedRefillReminderIds: refillReminderIds,
        repointedMaintenanceRecordIds: maintenanceRecordIds,
        repointedBillIds: billIds,
        actorUserId,
      });

      return { vaccinationIds, refillReminderIds, maintenanceRecordIds, billIds };
    });

    return {
      lineageId,
      repointedVaccinationCount: repointed.vaccinationIds.length,
      repointedRefillReminderCount: repointed.refillReminderIds.length,
      repointedMaintenanceRecordCount: repointed.maintenanceRecordIds.length,
      repointedBillCount: repointed.billIds.length,
    };
  }

  /** Reverses exactly one merge: restores the merged pet row and repoints only the rows THAT merge actually
   * moved (mirrors PeopleService.unmergePeople). On-profile field fills (microchip/vet/insurance/breed) are
   * NOT reverted — see mergePets' own doc comment on why that's deliberately one-way. */
  async unmergePets(lineageId: string, actorUserId: string) {
    const [lineage] = await this.db.select().from(schema.petMergeLineage).where(eq(schema.petMergeLineage.id, lineageId)).limit(1);
    if (!lineage) throw new NotFoundException({ code: "MERGE_NOT_FOUND", message: "That merge record was not found." });
    if (lineage.unmergedAt) throw new BadRequestException({ code: "ALREADY_UNMERGED", message: "That merge was already undone." });
    if (lineage.actorUserId !== actorUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only undo your own merges." });

    await this.db.transaction(async (tx) => {
      await tx.update(schema.petProfiles).set({ mergedIntoPetId: null, updatedAt: new Date() }).where(eq(schema.petProfiles.id, lineage.mergedPetId));
      if (lineage.repointedVaccinationIds.length > 0) {
        await tx.update(schema.petVaccinations).set({ petProfileId: lineage.mergedPetId }).where(inArray(schema.petVaccinations.id, lineage.repointedVaccinationIds));
      }
      if (lineage.repointedRefillReminderIds.length > 0) {
        await tx.update(schema.refillReminders).set({ petProfileId: lineage.mergedPetId }).where(inArray(schema.refillReminders.id, lineage.repointedRefillReminderIds));
      }
      if (lineage.repointedMaintenanceRecordIds.length > 0) {
        await tx.update(schema.maintenanceRecords).set({ petProfileId: lineage.mergedPetId }).where(inArray(schema.maintenanceRecords.id, lineage.repointedMaintenanceRecordIds));
      }
      if (lineage.repointedBillIds.length > 0) {
        await tx.update(schema.bills).set({ petProfileId: lineage.mergedPetId }).where(inArray(schema.bills.id, lineage.repointedBillIds));
      }
      await tx.update(schema.petMergeLineage).set({ unmergedAt: new Date() }).where(eq(schema.petMergeLineage.id, lineageId));
    });

    return {
      restoredVaccinationCount: lineage.repointedVaccinationIds.length,
      restoredRefillReminderCount: lineage.repointedRefillReminderIds.length,
      restoredMaintenanceRecordCount: lineage.repointedMaintenanceRecordIds.length,
      restoredBillCount: lineage.repointedBillIds.length,
    };
  }

  private async assertHouseholdMember(householdId: string, userId: string): Promise<void> {
    const [membership] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.userId, userId), eq(schema.householdMemberships.status, "active")))
      .limit(1);
    if (!membership) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
  }

  /** Same shape as AssetsService.assertAssetAccess — see its own doc comment on `requiredRight`. */
  private async assertPetAccess(
    ownerUserId: string,
    householdId: string | null,
    userId: string,
    grant?: { resourceType: string; resourceId: string },
    requiredRight: ResourceGrantRight = "view",
  ): Promise<void> {
    if (ownerUserId === userId) return;
    const householdIds = householdId
      ? [...(await this.households.delegatedHouseholdIds(userId, "commerce:read")), ...(await this.households.activeHouseholdIds(userId))]
      : [];
    if (householdId && householdIds.includes(householdId)) return;
    if (grant && (await this.sharing.hasGrantAtLeast(grant.resourceType, grant.resourceId, userId, requiredRight))) {
      // §35 SHARE-007 "access_audit" — pets' own access gate calls hasGrantAtLeast directly (it needs the
      // right, not just "any active grant"), so it can't rely on SharingService.hasActiveGrant's own
      // built-in logging; recordGrantAccess is the explicit equivalent (see PeopleService.assertAccess's
      // identical reasoning).
      await this.sharing.recordGrantAccess(grant.resourceType, grant.resourceId, userId);
      return;
    }
    throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this." });
  }

  /** Plain ownership-or-household check with no grant — used only to decide whether a grant message is
   * even worth looking up (owner/household access never has one). */
  private async isOwnerOrHousehold(ownerUserId: string, householdId: string | null, userId: string): Promise<boolean> {
    if (ownerUserId === userId) return true;
    if (!householdId) return false;
    const householdIds = [...(await this.households.delegatedHouseholdIds(userId, "commerce:read")), ...(await this.households.activeHouseholdIds(userId))];
    return householdIds.includes(householdId);
  }

  /** Loads + access-checks a pet in one step, for the vaccination/refill-reminder sub-resource endpoints
   * (which need the pet row itself to check `householdId`, unlike AssetsService.createMaintenanceRecord's
   * property/vehicle branches, which don't return the row). */
  /**
   * SHARE-001 enforcement — every caller of this (addVaccination, addRefillReminder, assignVaccination,
   * assignEvent, loadOwnedRefillReminder) is a WRITE, so this now requires "edit"; before this pass it
   * called assertPetAccess with no `grant` at all, meaning a grantee of ANY right could never reach any of
   * these regardless of right — the same "no write path honors grants" gap as AssetsService's identical
   * fix, just in the opposite direction (over-restrictive rather than under-restrictive).
   */
  private async assertPetOrHouseholdAccess(petId: string, userId: string) {
    const [pet] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    if (!pet || pet.deletedAt) throw new NotFoundException({ code: "PET_NOT_FOUND", message: "Pet not found." });
    await this.assertPetAccess(pet.ownerUserId, pet.householdId, userId, { resourceType: "pet", resourceId: petId }, "edit");
    return pet;
  }

  /**
   * PET-001 "Pet is a household entity with configurable managers" / user action "assign household
   * manager" — found live: `update`/`remove` were hard `ownerUserId === userId` checks even though
   * `list`/`detail` already show a shared pet to every active household member (this class's own
   * `ownerOrDelegatedHousehold`) — nobody but whoever originally added the pet could ever edit it or
   * remove it, the exact gap PET-001 calls out. Reuses the existing caregiver-delegation mechanism
   * (HouseholdService.delegatedHouseholdIds) with a new "pets:manage" scope rather than a new schema
   * concept — an owner (or another manager) grants a specific co-member "pets:manage" the same
   * scoped/time-bound/revocable way every other domain's read delegation already works, and that member can
   * then edit/remove any of the household's pets, not just ones they personally added. Still owner-only for
   * the sharing endpoints below (createGrant/createShareLink/etc.) — PET-001's "manager" is an editing
   * right over the household's own pets, not a right to reshare a pet with outside parties on the owner's
   * behalf.
   */
  /**
   * SHARE-001 enforcement added — `requiredRight` lets `update` (edit) and `remove` (manage) demand
   * different strengths of a resourceGrant, on top of the pre-existing owner/household-manager paths
   * (unaffected). A grant is a THIRD, independent way in, for a grantee outside the pet's own household —
   * PET-001's own household-manager scope stays exactly as it was.
   */
  private async assertOwnedOrManagedPet(petId: string, userId: string, requiredRight: ResourceGrantRight = "edit") {
    const [pet] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    if (!pet || pet.deletedAt) throw new NotFoundException({ code: "PET_NOT_FOUND", message: "Pet not found." });
    if (pet.ownerUserId === userId) return pet;
    if (pet.householdId) {
      const managedHouseholdIds = await this.households.delegatedHouseholdIds(userId, "pets:manage");
      if (managedHouseholdIds.includes(pet.householdId)) return pet;
    }
    if (await this.sharing.hasGrantAtLeast("pet", petId, userId, requiredRight)) return pet;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner, an assigned household manager, or someone with sufficient shared access can edit this pet." });
  }

  /** A photo/vaccination document must belong to the same owner or household as the pet it's being
   * attached to — otherwise any authenticated user could point a pet at an arbitrary document id they
   * don't have access to and read it back via GET /v1/pets/:id. Mirrors DocumentsService's own
   * ownership check rather than calling into DocumentsService directly (same reasoning as
   * AssetsService.createMaintenanceRecord's direct petProfiles query — a plain ownership check, not a
   * call into that module's broader surface). */
  private async assertOwnedOrAccessibleDocument(documentId: string, petOwnerUserId: string, petHouseholdId: string | null, requestingUserId: string): Promise<void> {
    const [doc] = await this.db.select({ ownerUserId: schema.documents.ownerUserId, householdId: schema.documents.householdId }).from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Document not found." });
    const belongsToPetOwner = doc.ownerUserId === petOwnerUserId;
    const belongsToPetHousehold = petHouseholdId != null && doc.householdId === petHouseholdId;
    if (!belongsToPetOwner && !belongsToPetHousehold) {
      throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "That document isn't available to attach to this pet." });
    }
    // No petId threaded through this signature, only owner/household — so this deliberately can't honor a
    // direct pet grant the way assertPetOrHouseholdAccess does; every caller of this already separately
    // required "edit" via assertOwnedOrManagedPet/assertPetOrHouseholdAccess before reaching here, so this
    // is only ever reached by an owner/household path anyway in practice.
    if (doc.ownerUserId !== requestingUserId) await this.assertPetAccess(petOwnerUserId, petHouseholdId, requestingUserId);
  }

  // --- Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) — mirrors AssetsService's property/vehicle
  // sharing endpoints exactly, generalized via SharingService, resourceType "pet".

  /** SHARE-001 "manage = edit + delete + can grant/revoke others' access" — same reasoning as
   * AssetsService.assertOwnedOrManagedPropertyForSharing. */
  private async assertOwnedOrManagedPetForSharing(petId: string, userId: string) {
    const [pet] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    if (!pet || pet.deletedAt) throw new NotFoundException({ code: "PET_NOT_FOUND", message: "Pet not found." });
    if (pet.ownerUserId === userId) return pet;
    if (await this.sharing.hasGrantAtLeast("pet", petId, userId, "manage")) return pet;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or a manager can share this pet." });
  }

  private assertPublicLinkAllowed(sensitivity: string): void {
    // Same gate as AssetsService.assertPublicLinkAllowed — a microchip number at "highly_sensitive"/
    // "secret" shouldn't get an unauthenticated, internet-reachable link.
    if (sensitivity === "highly_sensitive" || sensitivity === "secret") {
      throw new ForbiddenException({
        code: "SENSITIVITY_BLOCKS_PUBLIC_LINK",
        message: "This pet's sensitivity level doesn't allow public share links. Share it directly with someone's Veynlo account instead.",
      });
    }
  }

  async createGrant(petId: string, requestingUserId: string, granteeEmail: string, expiresInDays?: number, right: ResourceGrantRight = "view", message?: string): Promise<{ id: string }> {
    await this.assertOwnedOrManagedPetForSharing(petId, requestingUserId);
    return this.sharing.createResourceGrant("pet", petId, requestingUserId, granteeEmail, expiresInDays, right, message);
  }

  async listGrants(petId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPetForSharing(petId, requestingUserId);
    return this.sharing.listResourceGrants("pet", petId);
  }

  async createShareLink(petId: string, requestingUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    const pet = await this.assertOwnedOrManagedPetForSharing(petId, requestingUserId);
    this.assertPublicLinkAllowed(pet.sensitivity);
    return this.sharing.createShareLink("pet", petId, requestingUserId, dto);
  }

  async listShareLinks(petId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPetForSharing(petId, requestingUserId);
    return this.sharing.listShareLinks("pet", petId);
  }

  /** SHARE-001 "preview exactly what recipient will see" — reuses publicPetContent. */
  async sharePreview(petId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPetForSharing(petId, requestingUserId);
    return this.publicPetContent(petId);
  }

  /** Public, unauthenticated redemption content for a pet share link — this is the boarding/emergency
   * "share the essentials" surface for a pet on its own (see EmergencyBinderService for the full
   * household-wide packet). Deliberately omits `microchipNumber` for the same reasoning
   * AssetsService.publicVehicleContent omits `vin`. */
  async publicPetContent(petId: string) {
    const [pet] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    if (!pet || pet.deletedAt) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    const [vaccinations, maintenance] = await Promise.all([
      this.db
        .select({ label: schema.petVaccinations.label, expirationDate: schema.petVaccinations.expirationDate })
        .from(schema.petVaccinations)
        .where(eq(schema.petVaccinations.petProfileId, petId)),
      this.db
        .select({ description: schema.maintenanceRecords.description, serviceDate: schema.maintenanceRecords.serviceDate })
        .from(schema.maintenanceRecords)
        .where(eq(schema.maintenanceRecords.petProfileId, petId))
        .orderBy(desc(schema.maintenanceRecords.serviceDateSort)),
    ]);
    return {
      label: pet.label,
      species: pet.species,
      breed: pet.breed,
      vetProviderName: pet.vetProviderName,
      insuranceProviderName: pet.insuranceProviderName,
      vaccinations,
      maintenance,
    };
  }

  async revokeResourceGrant(grantId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "pet") return false;
      return (await this.sharing.hasGrantAtLeast("pet", resourceId, requestingUserId, "manage")) || (await this.isOwnedPet(resourceId, requestingUserId));
    });
  }

  async revokeShareLink(linkId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeShareLink(linkId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "pet") return false;
      return (await this.sharing.hasGrantAtLeast("pet", resourceId, requestingUserId, "manage")) || (await this.isOwnedPet(resourceId, requestingUserId));
    });
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listAccessEvents(petId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPetForSharing(petId, requestingUserId);
    return this.sharing.listAccessEvents("pet", petId);
  }

  private async isOwnedPet(petId: string, userId: string): Promise<boolean> {
    const [pet] = await this.db.select({ ownerUserId: schema.petProfiles.ownerUserId }).from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    return pet?.ownerUserId === userId;
  }
}
