import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { generateId, type TemporalValue } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { IdentityService } from "../identity/identity.service";
import { identityRecordSafeColumns } from "./identity-records.util";
import { resolveJurisdictionLink, setUserJurisdictionLink, type ResolvedJurisdictionLink } from "./jurisdiction-link-resolver";
import type { CreateIdentityRecordDto, UpdateIdentityRecordDto, RenewIdentityRecordDto, SetJurisdictionLinkDto } from "./dto";

function toTemporalDate(iso: string | null | undefined): { value: TemporalValue | null; sort: Date | null } {
  if (!iso) return { value: null, sort: null };
  const date = iso.slice(0, 10);
  return { value: { precision: "date", instantUtc: null, date, timezone: null, sourceText: null }, sort: new Date(`${date}T00:00:00Z`) };
}

/**
 * "Identity & Legal Continuity" (ID-001 passport, ID-002 driver's license/state ID, ID-003 vehicle
 * registration, ID-004 professional/recreational licenses, ID-005 property/government obligations). See
 * packages/db/src/schema/identity-records.ts's own doc comment for the table shapes this wraps.
 *
 * ACCESS CONTROL — "private by default; explicit share for emergency/travel packets" (spec), the same
 * deliberately-stricter-than-usual stance `HealthLogisticsService` documents on itself: this module's read
 * paths NEVER OR in plain household membership OR a caregiver delegation, regardless of `visibility` — only
 * ownership or an explicit `resourceGrants` row (SharingService, resourceType "identity_record") ever grants
 * another user access to a record. `EmergencyBinderService.getBinder` is the one sanctioned exception, and it
 * reads `identity_records` directly (via `identityRecordSafeColumns`, excluding `documentNumber`) rather than
 * through this service, exactly like it already does for `vehicleProfiles`/`propertyProfiles`/`petProfiles`.
 *
 * `documentNumber` (envelope-encrypted at rest via the standard `encryptedText` column type) is additionally
 * excluded from every method here except `revealDocumentNumber` — see `identityRecordSafeColumns`'s own doc
 * comment in identity-records.util.ts.
 */
@Injectable()
export class IdentityRecordsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private async accessCondition(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("identity_record", userId);
    const conditions = [eq(schema.identityRecords.ownerUserId, userId)];
    if (grantedIds.length > 0) conditions.push(inArray(schema.identityRecords.id, grantedIds));
    return or(...conditions)!;
  }

  async list(userId: string) {
    const access = await this.accessCondition(userId);
    return this.db
      .select(identityRecordSafeColumns)
      .from(schema.identityRecords)
      .where(and(access, isNull(schema.identityRecords.deletedAt)))
      .orderBy(schema.identityRecords.expirationDateSort);
  }

  private async assertAccess(id: string, userId: string) {
    const [row] = await this.db.select(identityRecordSafeColumns).from(schema.identityRecords).where(eq(schema.identityRecords.id, id)).limit(1);
    if (!row || row.deletedAt) throw new NotFoundException({ code: "IDENTITY_RECORD_NOT_FOUND", message: "Not found." });
    if (row.ownerUserId !== userId && !(await this.sharing.hasActiveGrant("identity_record", id, userId))) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You don't have access to this record." });
    }
    return row;
  }

  private async assertOwned(id: string, userId: string) {
    const [row] = await this.db.select(identityRecordSafeColumns).from(schema.identityRecords).where(eq(schema.identityRecords.id, id)).limit(1);
    if (!row || row.deletedAt) throw new NotFoundException({ code: "IDENTITY_RECORD_NOT_FOUND", message: "Not found." });
    if (row.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your record." });
    return row;
  }

  async detail(id: string, userId: string) {
    const record = await this.assertAccess(id, userId);
    const renewalLink: ResolvedJurisdictionLink | null = record.renewalUrl
      ? { url: record.renewalUrl, label: "Your saved renewal link", sourceNote: null, source: "user", linkId: record.id }
      : await resolveJurisdictionLink(this.db, record.recordType, record.jurisdiction, record.ownerUserId);

    let linkedDocument: { id: string; title: string; documentType: string } | null = null;
    if (record.linkedDocumentId) {
      const [doc] = await this.db
        .select({ id: schema.documents.id, title: schema.documents.title, documentType: schema.documents.documentType })
        .from(schema.documents)
        .where(eq(schema.documents.id, record.linkedDocumentId))
        .limit(1);
      linkedDocument = doc ?? null;
    }
    let linkedVehicle: { id: string; label: string } | null = null;
    if (record.linkedVehicleId) {
      const [v] = await this.db.select({ id: schema.vehicleProfiles.id, label: schema.vehicleProfiles.label }).from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, record.linkedVehicleId)).limit(1);
      linkedVehicle = v ?? null;
    }
    let linkedProperty: { id: string; label: string } | null = null;
    if (record.linkedPropertyId) {
      const [p] = await this.db.select({ id: schema.propertyProfiles.id, label: schema.propertyProfiles.label }).from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, record.linkedPropertyId)).limit(1);
      linkedProperty = p ?? null;
    }
    // ID-005 versioning chain — "renewed from" pointer, the inverse of this record's own
    // `supersededByRecordId` (which points forward, from an OLD record to its replacement).
    const [previousVersion] = await this.db
      .select({ id: schema.identityRecords.id, label: schema.identityRecords.label })
      .from(schema.identityRecords)
      .where(eq(schema.identityRecords.supersededByRecordId, id));

    return { record, renewalLink, linkedDocument, linkedVehicle, linkedProperty, previousVersion: previousVersion ?? null };
  }

  private async assertOwnedVehicle(vehicleId: string, userId: string): Promise<void> {
    const [v] = await this.db.select({ ownerUserId: schema.vehicleProfiles.ownerUserId }).from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!v || v.ownerUserId !== userId) throw new BadRequestException({ code: "INVALID_VEHICLE", message: "That vehicle isn't yours." });
  }

  private async assertOwnedProperty(propertyId: string, userId: string): Promise<void> {
    const [p] = await this.db.select({ ownerUserId: schema.propertyProfiles.ownerUserId }).from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId)).limit(1);
    if (!p || p.ownerUserId !== userId) throw new BadRequestException({ code: "INVALID_PROPERTY", message: "That property isn't yours." });
  }

  async create(userId: string, dto: CreateIdentityRecordDto): Promise<{ id: string }> {
    if (dto.householdId) {
      const isMember = await this.households.isActiveMember(dto.householdId, userId);
      if (!isMember) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
    }
    if (dto.linkedVehicleId) await this.assertOwnedVehicle(dto.linkedVehicleId, userId);
    if (dto.linkedPropertyId) await this.assertOwnedProperty(dto.linkedPropertyId, userId);
    const issued = toTemporalDate(dto.issuedIso);
    const expiration = toTemporalDate(dto.expirationIso);
    const id = generateId("identityRecord");
    await this.db.insert(schema.identityRecords).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      recordType: dto.recordType,
      label: dto.label,
      issuingAuthority: dto.issuingAuthority ?? null,
      documentNumber: dto.documentNumber ?? null,
      issuedDate: issued.value,
      expirationDate: expiration.value,
      expirationDateSort: expiration.sort,
      linkedVehicleId: dto.linkedVehicleId ?? null,
      linkedPropertyId: dto.linkedPropertyId ?? null,
      jurisdiction: dto.jurisdiction ?? null,
      reminderLeadDays: dto.reminderLeadDays ?? 60,
      status: "active",
      visibility: "private",
    });
    return { id };
  }

  async update(id: string, userId: string, dto: UpdateIdentityRecordDto): Promise<void> {
    await this.assertOwned(id, userId);
    if (dto.linkedVehicleId) await this.assertOwnedVehicle(dto.linkedVehicleId, userId);
    if (dto.linkedPropertyId) await this.assertOwnedProperty(dto.linkedPropertyId, userId);
    const updates: Partial<typeof schema.identityRecords.$inferInsert> = { updatedAt: new Date() };
    if (dto.label !== undefined) updates.label = dto.label;
    if ("issuingAuthority" in dto) updates.issuingAuthority = dto.issuingAuthority ?? null;
    if ("documentNumber" in dto) updates.documentNumber = dto.documentNumber ?? null;
    if ("issuedIso" in dto) updates.issuedDate = toTemporalDate(dto.issuedIso).value;
    if ("expirationIso" in dto) {
      const expiration = toTemporalDate(dto.expirationIso);
      updates.expirationDate = expiration.value;
      updates.expirationDateSort = expiration.sort;
    }
    if ("jurisdiction" in dto) updates.jurisdiction = dto.jurisdiction ?? null;
    if ("linkedVehicleId" in dto) updates.linkedVehicleId = dto.linkedVehicleId ?? null;
    if ("linkedPropertyId" in dto) updates.linkedPropertyId = dto.linkedPropertyId ?? null;
    if ("renewalUrl" in dto) updates.renewalUrl = dto.renewalUrl ?? null;
    if (dto.reminderLeadDays !== undefined) updates.reminderLeadDays = dto.reminderLeadDays;
    await this.db.update(schema.identityRecords).set(updates).where(eq(schema.identityRecords.id, id));
  }

  async delete(id: string, userId: string): Promise<void> {
    await this.assertOwned(id, userId);
    await this.db.update(schema.identityRecords).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.identityRecords.id, id));
  }

  async linkDocument(id: string, userId: string, documentId: string): Promise<void> {
    await this.assertOwned(id, userId);
    const [doc] = await this.db.select({ ownerUserId: schema.documents.ownerUserId, deletedAt: schema.documents.deletedAt }).from(schema.documents).where(eq(schema.documents.id, documentId)).limit(1);
    if (!doc || doc.deletedAt) throw new NotFoundException({ code: "DOCUMENT_NOT_FOUND", message: "Not found." });
    if (doc.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Not your document." });
    await this.db.update(schema.identityRecords).set({ linkedDocumentId: documentId, updatedAt: new Date() }).where(eq(schema.identityRecords.id, id));
  }

  async unlinkDocument(id: string, userId: string): Promise<void> {
    await this.assertOwned(id, userId);
    await this.db.update(schema.identityRecords).set({ linkedDocumentId: null, updatedAt: new Date() }).where(eq(schema.identityRecords.id, id));
  }

  /**
   * ID-001..005 "reveal/copy protected field" — the §28.9 step-up gate the whole build brief calls for.
   * Baseline access (owner OR an active `resourceGrants` row, same as `assertAccess`) is checked FIRST, then
   * the CALLING user's own account password via `IdentityService.verifyStepUpPassword` — identical ordering
   * and reasoning to `HealthLogisticsService.openHealthDocument`: never spend a step-up prompt confirming a
   * password before finding out the record isn't even accessible to this caller, and a grantee re-proves
   * *their own* password, not the owner's. Every outcome (success, missing password, wrong password) writes
   * an immutable `audit_events` row — spec's own "secure-field reveal events" analytics signal, and the same
   * "both halves of reauth" discipline `openHealthDocument`'s doc comment documents.
   */
  async revealDocumentNumber(id: string, userId: string, password: string | undefined): Promise<{ documentNumber: string | null }> {
    await this.assertAccess(id, userId);
    try {
      await this.identity.verifyStepUpPassword(userId, password);
    } catch (err) {
      await this.recordRevealEvent(userId, id, password ? "failure" : "denied");
      throw err;
    }
    await this.recordRevealEvent(userId, id, "success");
    const [row] = await this.db.select({ documentNumber: schema.identityRecords.documentNumber }).from(schema.identityRecords).where(eq(schema.identityRecords.id, id)).limit(1);
    return { documentNumber: row?.documentNumber ?? null };
  }

  private async recordRevealEvent(userId: string, recordId: string, result: "success" | "failure" | "denied"): Promise<void> {
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: userId,
      action: "identity_record.reveal_document_number",
      resourceType: "identity_record",
      resourceId: recordId,
      result,
    });
  }

  /**
   * ID-001..005 "attach new version"/"mark renewed" — creates a NEW row (a fresh id, status "active") and
   * marks the OLD row `status: "renewed"` with `supersededByRecordId` pointing at the new row; the old row is
   * never deleted (spec's own audit-trail framing: "successful version rollover" is one of this domain's
   * named quality signals, which needs the old row to still exist to look back on). Fields omitted from
   * `dto` carry over unchanged from the old record — a renewal is usually "same document, new number/dates,"
   * not a from-scratch re-entry. `linkedVehicleId`/`linkedPropertyId`/`jurisdiction`/`reminderLeadDays`/
   * `householdId` always carry over (a renewed vehicle registration is still for the same vehicle).
   */
  async renewRecord(id: string, userId: string, dto: RenewIdentityRecordDto): Promise<{ id: string }> {
    const old = await this.assertOwned(id, userId);
    if (old.status === "renewed") {
      throw new BadRequestException({ code: "ALREADY_RENEWED", message: "This record has already been renewed — see its newer version." });
    }
    const issued = "issuedIso" in dto ? toTemporalDate(dto.issuedIso) : { value: old.issuedDate, sort: null };
    const expiration = "expirationIso" in dto ? toTemporalDate(dto.expirationIso) : { value: old.expirationDate, sort: old.expirationDateSort };
    const newId = generateId("identityRecord");
    await this.db.insert(schema.identityRecords).values({
      id: newId,
      ownerUserId: old.ownerUserId,
      householdId: old.householdId,
      recordType: old.recordType,
      label: dto.label ?? old.label,
      issuingAuthority: "issuingAuthority" in dto ? (dto.issuingAuthority ?? null) : old.issuingAuthority,
      documentNumber: "documentNumber" in dto ? (dto.documentNumber ?? null) : null, // a renewed document usually gets a NEW number — never silently copy the old one forward unless explicitly given
      issuedDate: issued.value,
      expirationDate: expiration.value,
      expirationDateSort: expiration.sort,
      linkedVehicleId: old.linkedVehicleId,
      linkedPropertyId: old.linkedPropertyId,
      jurisdiction: old.jurisdiction,
      reminderLeadDays: old.reminderLeadDays,
      status: "active",
      visibility: "private",
    });
    await this.db.update(schema.identityRecords).set({ status: "renewed", supersededByRecordId: newId, updatedAt: new Date() }).where(eq(schema.identityRecords.id, id));
    await this.db.insert(schema.auditEvents).values({
      id: generateId("auditEvent"),
      actorType: "user",
      actorId: userId,
      action: "identity_record.renew",
      resourceType: "identity_record",
      resourceId: id,
      afterJson: { newRecordId: newId },
      result: "success",
    });
    return { id: newId };
  }

  /** ID-001/002/003 "link official renewal site" (registry-editing half) — a user's own correction/addition
   * to the curated jurisdiction-link registry, scoped to their own account (see jurisdiction-link-
   * resolver.ts's precedence rule: this always outranks the seeded global row for this same caller). Not
   * scoped to any one record — corrects the (recordType, jurisdiction) pair itself, so it also improves the
   * resolved link for any other record this user has (or later adds) of the same type/jurisdiction. */
  async setJurisdictionLink(userId: string, dto: SetJurisdictionLinkDto): Promise<{ id: string }> {
    return setUserJurisdictionLink(this.db, userId, dto.recordType, dto.jurisdiction, { url: dto.url, label: dto.label, sourceNote: dto.sourceNote });
  }

  // ---------------------------------------------------------------------------------------------------
  // Sharing — "explicit share for emergency/travel packets" (spec). Mirrors HealthLogisticsService's
  // identical grants/share-links route shape so the generic web/mobile ShareResourcePanel component works
  // unmodified against "/v1/identity-records" as its collectionPath.
  // ---------------------------------------------------------------------------------------------------

  async createRecordGrant(id: string, userId: string, granteeEmail: string, expiresInDays?: number) {
    await this.assertOwned(id, userId);
    return this.sharing.createResourceGrant("identity_record", id, userId, granteeEmail, expiresInDays);
  }

  async listRecordGrants(id: string, userId: string) {
    await this.assertAccess(id, userId);
    return this.sharing.listResourceGrants("identity_record", id);
  }

  async revokeRecordGrant(grantId: string, userId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, userId);
  }

  /** Deliberately always rejects, same posture (and reasoning) as
   * `HealthLogisticsService.createAppointmentShareLink` — this domain is at least as sensitive as health
   * logistics (a literal government identity-document number), so an unauthenticated public link is never
   * offered; named-recipient grants (above) are the only sharing mechanism. Kept as a real endpoint so the
   * generic sharing UI gets a clean, specific error instead of a 404. */
  async createRecordShareLink(id: string, userId: string): Promise<never> {
    await this.assertOwned(id, userId);
    throw new ForbiddenException({
      code: "PUBLIC_LINKS_DISABLED_FOR_IDENTITY_RECORDS",
      message: "Identity records can't be shared via public link. Share directly with someone's Veynlo account instead.",
    });
  }

  async listRecordShareLinks(id: string, userId: string) {
    await this.assertAccess(id, userId);
    return this.sharing.listShareLinks("identity_record", id);
  }

  /** §35 SHARE-007 "access history" — owner-only (matches createRecordGrant's own gate, not the broader
   * assertAccess listRecordGrants/listRecordShareLinks use): this domain's own sensitivity bar means "who's
   * viewed my identity record" shouldn't itself be visible to a grantee, only the owner. */
  async listAccessEvents(id: string, userId: string) {
    await this.assertOwned(id, userId);
    return this.sharing.listAccessEvents("identity_record", id);
  }
}
