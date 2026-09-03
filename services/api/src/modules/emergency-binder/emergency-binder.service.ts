import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { IdentityService } from "../identity/identity.service";
import { identityRecordSafeColumns } from "../identity-records/identity-records.util";
import type { UpdateEmergencyBinderSettingsDto } from "./dto";

/**
 * Phase 2 §52.2 "emergency binder", the cross-domain packet spec §53's Future Feature Inventory describes
 * ("Identity/legal continuity: emergency/evacuation packet"), closing the gap flagged in
 * docs/PHASE2_PENDING_CREDENTIALS.md: until now the binder was document-only (see DocumentsService's own
 * `emergencyBinderItems`). This service is deliberately thin — it aggregates rows that already live in
 * their own domain tables (household roster, vehicles, properties, flagged documents) plus the two new
 * household-level free-text fields, rather than owning a new domain of its own. Queries the underlying
 * tables directly instead of going through AssetsService/DocumentsService's own household-scoped list
 * methods: those are scoped to "everything a given USER can see across every household they're in", but
 * the binder needs "everything belonging to THIS household regardless of which member owns it" — a
 * different shape of query that's simpler to write directly here than to bolt onto those services.
 */
@Injectable()
export class EmergencyBinderService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  /**
   * The medications/instructions free-text fields alone (unlike the full aggregated binder below) are
   * deliberately NOT step-up gated — they're one household setting among several (name, members, etc.),
   * all read/edited from the same non-step-up-gated household settings page today. What the spec actually
   * calls "biometric-protected" is the *combined* packet — identity + vehicles + property + medications +
   * instructions all at once, which is what makes it uniquely useful to an attacker — not any single field
   * of it in isolation. See getBinder() below for the gated aggregate view.
   */
  async getSettings(householdId: string, userId: string) {
    await this.assertActiveMember(householdId, userId);
    const [household] = await this.db
      .select({ medicationsNotes: schema.households.medicationsNotes, emergencyInstructions: schema.households.emergencyInstructions })
      .from(schema.households)
      .where(eq(schema.households.id, householdId))
      .limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });
    return household;
  }

  /** Editable by any adult member — same permission model as every other household-settings write (see
   * household.service.ts's invite()/rename() role checks), not owner-only: this is shared family
   * information any adult in the household should be able to keep current. */
  async updateSettings(householdId: string, userId: string, dto: UpdateEmergencyBinderSettingsDto) {
    await this.assertAdultMember(householdId, userId);
    const [household] = await this.db.select({ id: schema.households.id }).from(schema.households).where(eq(schema.households.id, householdId)).limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });
    const updates: { updatedAt: Date; medicationsNotes?: string | null; emergencyInstructions?: string | null } = { updatedAt: new Date() };
    if ("medicationsNotes" in dto) updates.medicationsNotes = dto.medicationsNotes ?? null;
    if ("emergencyInstructions" in dto) updates.emergencyInstructions = dto.emergencyInstructions ?? null;
    await this.db.update(schema.households).set(updates).where(eq(schema.households.id, householdId));
    return { id: householdId };
  }

  /**
   * The gated aggregate view — spec's "biometric-protected" requirement, enforced server-side via the
   * same §28.9 step-up password check every other sensitive-action endpoint uses (see
   * identity.service.ts's verifyStepUpPassword doc comment: a no-op for an OAuth-only account, since a
   * password is the only step-up factor this app has). Mobile additionally gates the screen itself behind
   * a real biometric prompt before ever calling this endpoint (see apps/mobile's emergency-binder screen)
   * — this server-side check is what makes that a real control rather than a client-only convenience,
   * since nothing stops a request to this endpoint from bypassing a client-side-only gate.
   */
  async getBinder(householdId: string, userId: string, password: string | undefined) {
    await this.assertActiveMember(householdId, userId);
    await this.identity.verifyStepUpPassword(userId, password);

    const [household] = await this.db
      .select({ id: schema.households.id, name: schema.households.name, medicationsNotes: schema.households.medicationsNotes, emergencyInstructions: schema.households.emergencyInstructions })
      .from(schema.households)
      .where(eq(schema.households.id, householdId))
      .limit(1);
    if (!household) throw new NotFoundException({ code: "HOUSEHOLD_NOT_FOUND", message: "Household not found." });

    const memberRows = await this.db
      .select({
        id: schema.householdMemberships.id,
        userId: schema.householdMemberships.userId,
        role: schema.householdMemberships.role,
        relationshipLabel: schema.householdMemberships.relationshipLabel,
        status: schema.householdMemberships.status,
        displayName: schema.users.displayName,
        email: schema.users.email,
      })
      .from(schema.householdMemberships)
      .leftJoin(schema.users, eq(schema.users.id, schema.householdMemberships.userId))
      .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.status, "active")));

    const dependents = await this.db
      .select({ id: schema.dependentProfiles.id, displayName: schema.dependentProfiles.displayName, birthDate: schema.dependentProfiles.birthDate })
      .from(schema.dependentProfiles)
      .where(eq(schema.dependentProfiles.householdId, householdId));

    const vehicles = await this.db
      .select({ id: schema.vehicleProfiles.id, label: schema.vehicleProfiles.label, make: schema.vehicleProfiles.make, model: schema.vehicleProfiles.model, year: schema.vehicleProfiles.year, vin: schema.vehicleProfiles.vin })
      .from(schema.vehicleProfiles)
      .where(and(eq(schema.vehicleProfiles.householdId, householdId), isNull(schema.vehicleProfiles.deletedAt)));

    const properties = await this.db
      .select({ id: schema.propertyProfiles.id, label: schema.propertyProfiles.label, propertyType: schema.propertyProfiles.propertyType, address: schema.propertyProfiles.address })
      .from(schema.propertyProfiles)
      .where(and(eq(schema.propertyProfiles.householdId, householdId), isNull(schema.propertyProfiles.deletedAt)));

    // PET-001/PET-005 "share boarding/emergency packet" — this feature's own explicit requirement is that
    // the household-wide emergency binder already built this session is the right home for it (see this
    // module's own doc comment: "aggregates rows that already live in their own domain tables"), rather
    // than a separate pet-specific export mechanism. `microchipNumber` is included even though it's
    // encrypted/genuinely-identifying data — same precedent as `vehicles.vin` two lines below, both already
    // sitting behind this same §28.9 step-up gate.
    const pets = await this.db
      .select({
        id: schema.petProfiles.id,
        label: schema.petProfiles.label,
        species: schema.petProfiles.species,
        breed: schema.petProfiles.breed,
        microchipNumber: schema.petProfiles.microchipNumber,
        vetProviderName: schema.petProfiles.vetProviderName,
        insuranceProviderName: schema.petProfiles.insuranceProviderName,
      })
      .from(schema.petProfiles)
      .where(and(eq(schema.petProfiles.householdId, householdId), isNull(schema.petProfiles.deletedAt), ne(schema.petProfiles.lifecycleStatus, "deceased")));
    const petIds = pets.map((p) => p.id);
    const petVaccinations =
      petIds.length > 0
        ? await this.db
            .select({ petProfileId: schema.petVaccinations.petProfileId, label: schema.petVaccinations.label, expirationDate: schema.petVaccinations.expirationDate })
            .from(schema.petVaccinations)
            .where(and(inArray(schema.petVaccinations.petProfileId, petIds), eq(schema.petVaccinations.source, "user_confirmed")))
        : [];
    const petRefillReminders =
      petIds.length > 0
        ? await this.db
            .select({ petProfileId: schema.refillReminders.petProfileId, medicationName: schema.refillReminders.medicationName, nextRefillDate: schema.refillReminders.nextRefillDate, pharmacy: schema.refillReminders.pharmacy })
            .from(schema.refillReminders)
            .where(and(inArray(schema.refillReminders.petProfileId, petIds), isNull(schema.refillReminders.deletedAt)))
        : [];
    const petsWithRecords = pets.map((pet) => ({
      ...pet,
      vaccinations: petVaccinations.filter((v) => v.petProfileId === pet.id).map(({ label, expirationDate }) => ({ label, expirationDate })),
      medications: petRefillReminders.filter((r) => r.petProfileId === pet.id).map(({ medicationName, nextRefillDate, pharmacy }) => ({ medicationName, nextRefillDate, pharmacy })),
    }));

    // "Identity & Legal Continuity" (ID-001..005) — the "explicit share for emergency/travel packets" this
    // domain's own private-by-default access model calls out (see identity-records.ts's own doc comment: an
    // identity record is otherwise invisible to anyone but its owner, no matter their household role).
    // Queried directly here rather than through IdentityRecordsService, same "this service reads the
    // underlying tables directly" shape this class already uses for vehicles/properties/pets above — and,
    // critically, via `identityRecordSafeColumns` (excludes `document_number`): unlocking the binder's own
    // §28.9 step-up gate authorizes seeing THAT a record exists, its type/label/issuing authority/expiration
    // — never the raw document number, which stays behind IdentityRecordsService.revealDocumentNumber's own,
    // separate step-up check even from inside an already-unlocked binder (spec: never show a raw passport
    // number in an aggregated view just because the binder itself was unlocked). `status !== "renewed"`
    // excludes a superseded old version — the binder should show the CURRENT record, not every historical one.
    const identityRecordRows = await this.db
      .select(identityRecordSafeColumns)
      .from(schema.identityRecords)
      .where(and(eq(schema.identityRecords.householdId, householdId), ne(schema.identityRecords.status, "renewed"), isNull(schema.identityRecords.deletedAt)));
    const identityRecords = identityRecordRows.map((r) => ({
      id: r.id,
      recordType: r.recordType,
      label: r.label,
      issuingAuthority: r.issuingAuthority,
      expirationDate: r.expirationDate,
      status: r.status,
    }));

    // Same filter DocumentsService.emergencyBinderItems uses — kept in sync deliberately rather than
    // calling that method directly, since this service only needs read access to `schema.documents`, not
    // the rest of DocumentsService's much larger surface (upload, OCR, sharing, etc.).
    const documents = await this.db
      .select({ id: schema.documents.id, title: schema.documents.title, documentType: schema.documents.documentType })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.householdId, householdId),
          eq(schema.documents.isEmergencyBinderItem, true),
          ne(schema.documents.visibility, "private"),
          isNull(schema.documents.deletedAt),
        ),
      );

    return {
      household: { id: household.id, name: household.name },
      medicationsNotes: household.medicationsNotes,
      emergencyInstructions: household.emergencyInstructions,
      members: memberRows,
      dependents,
      vehicles,
      properties,
      pets: petsWithRecords,
      identityRecords,
      documents,
      generatedAt: new Date().toISOString(),
    };
  }

  private async assertActiveMember(householdId: string, userId: string): Promise<void> {
    const isMember = await this.households.isActiveMember(householdId, userId);
    if (!isMember) throw new ForbiddenException({ code: "NOT_A_MEMBER", message: "You are not a member of this household." });
  }

  private async assertAdultMember(householdId: string, userId: string): Promise<void> {
    const [membership] = await this.db
      .select({ role: schema.householdMemberships.role })
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.userId, userId), eq(schema.householdMemberships.status, "active")))
      .limit(1);
    if (!membership) throw new ForbiddenException({ code: "NOT_A_MEMBER", message: "You are not a member of this household." });
    if (membership.role !== "household_owner" && membership.role !== "adult_member") {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Only adult members can edit emergency binder settings." });
    }
  }
}
