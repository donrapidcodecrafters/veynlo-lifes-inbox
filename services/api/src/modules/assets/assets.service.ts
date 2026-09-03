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
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { RecallMonitorService } from "./recall-monitor.service";
import { VinDecodeService, type VinDecodeSuggestion } from "./vin-decode.service";
import { findHomeMaintenanceTemplate, findVehicleMaintenanceTemplate, HOME_MAINTENANCE_TEMPLATES, VEHICLE_MAINTENANCE_TEMPLATES } from "./maintenance-rule-templates";
import type {
  CreateMaintenanceRecordDto,
  CreatePropertyProfileDto,
  CreateVehicleProfileDto,
  UpdatePropertyProfileDto,
  UpdateVehicleProfileDto,
  CreateOdometerObservationDto,
  CreateTireDto,
  RecordTireRotationDto,
  ReplaceTireDto,
  CreateHomeAssetDto,
  UpdateHomeAssetDto,
  DecodeVinDto,
  CreateMaintenanceRuleDto,
  UpdateMaintenanceRuleDto,
  CompleteMaintenanceRuleDto,
  CreateMaintenanceRuleFromTemplateDto,
  CreateRegistrationRecordDto,
  UpdateRegistrationRecordDto,
  RenewRegistrationRecordDto,
} from "./dto";

function dateOnly(iso: string | null | undefined): TemporalValue | null {
  if (!iso) return null;
  return { precision: "date", instantUtc: null, date: iso.slice(0, 10), timezone: null, sourceText: null };
}

/** §40.1 "Vehicle ... VIN [is the] auto-merge standard" — trim + uppercase only (VINs are conventionally
 * uppercase alphanumeric already; this just tolerates a lowercase entry/typo in case, never a fuzzy edit
 * distance). Mirrors PeopleService's own normalizeEmail/normalizePhone precision-first shape. */
function normalizeVin(value: string): string {
  return value.trim().toUpperCase();
}

/** §40.1 "Property ... normalized full address + user property identity" — trim, lowercase, drop the
 * handful of punctuation marks an address commonly varies by ("123 Main St." vs "123 Main St"), and collapse
 * whitespace. Deliberately NOT a fuzzy/geocoded match (no geocoding provider is wired up in this codebase) —
 * per the spec's own §40.2 "precision-first thresholds... false non-merge is preferable to incorrectly
 * combining two ... properties," two addresses that merely look similar (different unit numbers, a typo)
 * must never be offered as a candidate. */
function normalizeAddress(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,#]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Phase 2 §52.2 "Home/property and vehicle profiles; service/warranty/maintenance history." Mirrors
 * CommerceService/ScheduleService's identical ownerOrDelegatedHousehold shape (same `commerce:read`
 * delegation scope — a property/vehicle profile is commerce-adjacent owned-asset data, not a new scope
 * worth adding to CAREGIVER_DELEGATION_SCOPES for what's currently one Phase 2 feature area).
 */
@Injectable()
export class AssetsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(SharingService) private readonly sharing: SharingService,
    @Inject(RecallMonitorService) private readonly recallMonitor: RecallMonitorService,
    @Inject(VinDecodeService) private readonly vinDecode: VinDecodeService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  // Also OR's in plain active membership (see HouseholdService.activeHouseholdIds's own doc comment) —
  // delegation alone meant an ordinary household member never saw a shared household property/vehicle
  // that someone else in the household added, confirmed live on the Life screen's Home/Vehicles sections.
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "commerce:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  // --- Property profiles -----------------------------------------------

  async listProperties(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("property", userId);
    const baseCondition = await this.ownerOrDelegatedHousehold(userId, schema.propertyProfiles.ownerUserId, schema.propertyProfiles.householdId);
    const accessCondition = grantedIds.length > 0 ? or(baseCondition, inArray(schema.propertyProfiles.id, grantedIds))! : baseCondition;
    return this.db
      .select()
      .from(schema.propertyProfiles)
      // §40.2 — a merged-away property (mergedIntoPropertyId set) is excluded from ordinary list queries,
      // same as deletedAt, but never hard-deleted — see mergeProperties' own doc comment.
      .where(and(isNull(schema.propertyProfiles.deletedAt), isNull(schema.propertyProfiles.mergedIntoPropertyId), accessCondition))
      .orderBy(asc(schema.propertyProfiles.label));
  }

  async createProperty(userId: string, dto: CreatePropertyProfileDto) {
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const id = generateId("property");
    await this.db.insert(schema.propertyProfiles).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      label: dto.label,
      propertyType: dto.propertyType,
      address: dto.address ?? null,
      moveInDate: dateOnly(dto.moveInDateIso),
    });
    return { id };
  }

  async propertyDetail(propertyId: string, userId: string) {
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId)).limit(1);
    if (!property || property.deletedAt || property.mergedIntoPropertyId) return null;
    await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: propertyId });
    // SHARE-001 "optional message" — same reasoning as ListsService.listDetail: null for owner/household
    // access, populated only for a grant-based visitor who has one.
    const sharedNote = (await this.isOwnerOrHousehold(property.ownerUserId, property.householdId, userId)) ? null : await this.sharing.grantMessage("property", propertyId, userId);
    const warranties = await this.db.select().from(schema.warranties).where(eq(schema.warranties.propertyProfileId, propertyId));
    const maintenance = await this.db
      .select()
      .from(schema.maintenanceRecords)
      .where(eq(schema.maintenanceRecords.propertyProfileId, propertyId))
      .orderBy(desc(schema.maintenanceRecords.serviceDateSort));
    // HOMEOS-008 — each home asset carries its own recall matches inline, same "no separate detail
    // endpoint needed" reasoning as vehicleDetail's recalls/odometer/tires above. N+1 (one recalls query
    // per asset) rather than a join: this app's per-household asset counts are small (see AssetsService's
    // own doc comment on scale elsewhere), and a join would need an awkward LEFT JOIN + in-app grouping for
    // what's otherwise a one-line loop.
    const homeAssetRows = await this.db
      .select()
      .from(schema.homeAssets)
      .where(and(eq(schema.homeAssets.propertyProfileId, propertyId), isNull(schema.homeAssets.deletedAt)))
      .orderBy(asc(schema.homeAssets.label));
    const homeAssets = await Promise.all(
      homeAssetRows.map(async (asset) => ({
        ...asset,
        recalls: await this.db.select().from(schema.recallMatches).where(eq(schema.recallMatches.homeAssetId, asset.id)).orderBy(desc(schema.recallMatches.checkedAt)),
        // HOMEOS-004 — each home asset carries its own maintenance rules inline, same N+1-but-small-table
        // reasoning as `recalls` just above.
        maintenanceRules: await this.db
          .select()
          .from(schema.maintenanceRules)
          .where(and(eq(schema.maintenanceRules.homeAssetId, asset.id), isNull(schema.maintenanceRules.deletedAt)))
          .orderBy(asc(schema.maintenanceRules.label)),
      })),
    );
    return { property, warranties, maintenance, homeAssets, sharedNote };
  }

  /**
   * Found live during the emergency-binder audit: there was no way to edit a property profile at all after
   * creation — only create/delete existed — so `householdId` (already accepted by createProperty's own
   * DTO) could never be assigned or changed afterward. This closes that gap generally (every create-time
   * field is now editable), not just for `householdId`, mirroring updateHomeAsset's "just the fields that
   * change" shape. Requires "edit" access like every other property write; reassigning to a NEW household
   * additionally requires the caller to actually be an active member of that household (same check
   * createProperty itself already makes), so this can't be used to silently move someone else's property
   * into a household the caller doesn't belong to.
   */
  async updateProperty(propertyId: string, userId: string, dto: UpdatePropertyProfileDto): Promise<void> {
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId)).limit(1);
    if (!property || property.deletedAt) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
    await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: propertyId }, "edit");
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.propertyType !== undefined) patch.propertyType = dto.propertyType;
    if (dto.address !== undefined) patch.address = dto.address ?? null;
    if (dto.moveInDateIso !== undefined) patch.moveInDate = dateOnly(dto.moveInDateIso);
    if ("householdId" in dto) patch.householdId = dto.householdId ?? null;
    await this.db.update(schema.propertyProfiles).set(patch).where(eq(schema.propertyProfiles.id, propertyId));
  }

  /** SHARE-001 "manage = edit + delete" — deleting the property/vehicle/pet itself needs "manage", not
   * just "edit" (owner-only before this pass). */
  async deleteProperty(propertyId: string, userId: string): Promise<void> {
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId)).limit(1);
    if (!property) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
    if (property.ownerUserId !== userId && !(await this.sharing.hasGrantAtLeast("property", propertyId, userId, "manage"))) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or someone with manage access can remove this property." });
    }
    await this.db.update(schema.propertyProfiles).set({ deletedAt: new Date() }).where(eq(schema.propertyProfiles.id, propertyId));
  }

  // --- Vehicle profiles ---------------------------------------------------

  async listVehicles(userId: string) {
    const grantedIds = await this.sharing.grantedResourceIds("vehicle", userId);
    const baseCondition = await this.ownerOrDelegatedHousehold(userId, schema.vehicleProfiles.ownerUserId, schema.vehicleProfiles.householdId);
    const accessCondition = grantedIds.length > 0 ? or(baseCondition, inArray(schema.vehicleProfiles.id, grantedIds))! : baseCondition;
    return this.db
      .select()
      .from(schema.vehicleProfiles)
      // §40.2 — a merged-away vehicle (mergedIntoVehicleId set) is excluded from ordinary list queries,
      // same as deletedAt, but never hard-deleted — see mergeVehicles' own doc comment.
      .where(and(isNull(schema.vehicleProfiles.deletedAt), isNull(schema.vehicleProfiles.mergedIntoVehicleId), accessCondition))
      .orderBy(asc(schema.vehicleProfiles.label));
  }

  async createVehicle(userId: string, dto: CreateVehicleProfileDto) {
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const id = generateId("vehicle");
    await this.db.insert(schema.vehicleProfiles).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      label: dto.label,
      make: dto.make ?? null,
      model: dto.model ?? null,
      year: dto.year ?? null,
      vin: dto.vin ?? null,
      purchaseDate: dateOnly(dto.purchaseDateIso),
    });
    // VEH-006 "trigger a recall check on vehicle-profile create" — off the request via the queue (same
    // "persist synchronously, do the external-API work in the background" split as
    // MemoriesService.create/enqueueMemoryClassification), not a synchronous NHTSA call inline here. A
    // vehicle with no make/model/year yet is simply not checkable — RecallMonitorService.checkVehicle
    // no-ops in that case rather than this call site needing to pre-check.
    await this.queue.enqueueRecallCheck({ subjectType: "vehicle", subjectId: id });
    return { id };
  }

  async vehicleDetail(vehicleId: string, userId: string) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle || vehicle.deletedAt || vehicle.mergedIntoVehicleId) return null;
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicleId });
    const sharedNote = (await this.isOwnerOrHousehold(vehicle.ownerUserId, vehicle.householdId, userId)) ? null : await this.sharing.grantMessage("vehicle", vehicleId, userId);
    const warranties = await this.db.select().from(schema.warranties).where(eq(schema.warranties.vehicleProfileId, vehicleId));
    const maintenance = await this.db
      .select()
      .from(schema.maintenanceRecords)
      .where(eq(schema.maintenanceRecords.vehicleProfileId, vehicleId))
      .orderBy(desc(schema.maintenanceRecords.serviceDateSort));
    // VEH-006/VEH-007 — recall matches, odometer history, and tires all surface on the same vehicle detail
    // response the way warranties/maintenance already do, rather than needing their own detail endpoints.
    const recalls = await this.db.select().from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, vehicleId)).orderBy(desc(schema.recallMatches.checkedAt));
    const odometerObservations = await this.db
      .select()
      .from(schema.odometerObservations)
      .where(eq(schema.odometerObservations.vehicleProfileId, vehicleId))
      .orderBy(desc(schema.odometerObservations.observedAtSort));
    const tires = await this.db.select().from(schema.tires).where(eq(schema.tires.vehicleProfileId, vehicleId)).orderBy(desc(schema.tires.createdAt));
    // HOMEOS-004/VEH-003/VEH-004 — maintenance rules and registration records surface on the same vehicle
    // detail response the way warranties/maintenance/recalls/odometer/tires already do.
    const maintenanceRules = await this.db
      .select()
      .from(schema.maintenanceRules)
      .where(and(eq(schema.maintenanceRules.vehicleProfileId, vehicleId), isNull(schema.maintenanceRules.deletedAt)))
      .orderBy(asc(schema.maintenanceRules.label));
    const registrationRecords = await this.db
      .select()
      .from(schema.registrationRecords)
      .where(and(eq(schema.registrationRecords.vehicleProfileId, vehicleId), isNull(schema.registrationRecords.deletedAt)))
      .orderBy(asc(schema.registrationRecords.renewalDueDateSort));
    return { vehicle, warranties, maintenance, recalls, odometerObservations, tires, maintenanceRules, registrationRecords, sharedNote };
  }

  /** See updateProperty's own doc comment — the vehicle-profile counterpart of the same "no edit endpoint
   * existed at all" gap. */
  async updateVehicle(vehicleId: string, userId: string, dto: UpdateVehicleProfileDto): Promise<void> {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicleId }, "edit");
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.make !== undefined) patch.make = dto.make ?? null;
    if (dto.model !== undefined) patch.model = dto.model ?? null;
    if (dto.year !== undefined) patch.year = dto.year ?? null;
    if (dto.vin !== undefined) patch.vin = dto.vin ?? null; // raw, not normalized — matches createVehicle's own storage (normalizeVin is only ever used for merge-candidate comparison)
    if (dto.purchaseDateIso !== undefined) patch.purchaseDate = dateOnly(dto.purchaseDateIso);
    if ("householdId" in dto) patch.householdId = dto.householdId ?? null;
    await this.db.update(schema.vehicleProfiles).set(patch).where(eq(schema.vehicleProfiles.id, vehicleId));
    // A newly set make/model/year is a fresh reason to re-check recalls, same reasoning as createVehicle's
    // own on-create check / updateHomeAsset's on-edit re-check.
    if (dto.make !== undefined || dto.model !== undefined || dto.year !== undefined) await this.queue.enqueueRecallCheck({ subjectType: "vehicle", subjectId: vehicleId });
  }

  async deleteVehicle(vehicleId: string, userId: string): Promise<void> {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    if (vehicle.ownerUserId !== userId && !(await this.sharing.hasGrantAtLeast("vehicle", vehicleId, userId, "manage"))) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or someone with manage access can remove this vehicle." });
    }
    await this.db.update(schema.vehicleProfiles).set({ deletedAt: new Date() }).where(eq(schema.vehicleProfiles.id, vehicleId));
  }

  // --- Maintenance records -------------------------------------------------

  async createMaintenanceRecord(userId: string, dto: CreateMaintenanceRecordDto) {
    // SHARE-001 enforcement — adding a maintenance record is a write, so a grant-based (as opposed to
    // owner/household) accessor now needs at least "edit" on the specific property/vehicle/pet; before
    // this pass these branches passed no `grant` at all, so a grantee of ANY right (including a future
    // "edit"/"manage") could never reach this at all — an accidental over-restriction in the opposite
    // direction from the "view grant can write" gap, fixed the same way: pass the grant through, at the
    // right required level.
    if (dto.propertyProfileId) {
      const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, dto.propertyProfileId)).limit(1);
      if (!property) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
      await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: dto.propertyProfileId }, "edit");
    }
    if (dto.vehicleProfileId) {
      const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, dto.vehicleProfileId)).limit(1);
      if (!vehicle) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
      await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: dto.vehicleProfileId }, "edit");
    }
    if (dto.petProfileId) {
      // Queried directly against petProfiles rather than via PetsModule/PetsService — same reasoning as
      // the property/vehicle branches above: this is a plain ownership/household check, not a call into
      // pets' broader surface, and keeps AssetsModule from needing a dependency on PetsModule.
      const [pet] = await this.db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, dto.petProfileId)).limit(1);
      if (!pet || pet.deletedAt) throw new NotFoundException({ code: "PET_NOT_FOUND", message: "Pet not found." });
      await this.assertAssetAccess(pet.ownerUserId, pet.householdId, userId, { resourceType: "pet", resourceId: dto.petProfileId }, "edit");
    }
    const serviceDate = dateOnly(dto.serviceDateIso);
    const id = generateId("maintenanceRecord");
    await this.db.insert(schema.maintenanceRecords).values({
      id,
      ownerUserId: userId,
      propertyProfileId: dto.propertyProfileId ?? null,
      vehicleProfileId: dto.vehicleProfileId ?? null,
      petProfileId: dto.petProfileId ?? null,
      description: dto.description,
      serviceDate,
      serviceDateSort: serviceDate?.date ? new Date(`${serviceDate.date}T00:00:00Z`) : null,
      costMinorUnits: dto.costMinorUnits ?? null,
      costCurrency: dto.costCurrency ?? null,
      confidenceBand: "verified", // user-entered directly, not AI-inferred — the same "nothing to doubt" reasoning as manual voice-note capture
    });
    return { id };
  }

  // --- Odometer observations (VEH-001/VEH-007) ------------------------------------------------------

  async recordOdometerObservation(userId: string, dto: CreateOdometerObservationDto) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, dto.vehicleProfileId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: dto.vehicleProfileId }, "edit");
    const observedAt = dateOnly(dto.observedAtIso ?? new Date().toISOString())!;
    const id = generateId("odometerObservation");
    await this.db.insert(schema.odometerObservations).values({
      id,
      ownerUserId: userId,
      vehicleProfileId: dto.vehicleProfileId,
      mileage: dto.mileage,
      observedAt,
      observedAtSort: new Date(`${observedAt.date}T00:00:00Z`),
      source: dto.source,
      confidenceBand: "verified", // user-entered directly, same reasoning as maintenanceRecords.confidenceBand
    });
    return { id };
  }

  /** The vehicle's current known odometer reading — the HIGHEST mileage ever recorded, not simply the
   * most-recently-dated observation, used by ScheduleService to evaluate a "mileage" recurrence rule
   * against this vehicle. Null when the vehicle has no readings at all yet.
   *
   * VEH-001's own "odometer rollback/data error" edge state: an odometer only counts up in normal
   * operation, so a later-dated observation with a LOWER mileage than one already on file is a data-entry
   * mistake (typo, wrong vehicle, stale receipt mileage), not a legitimate correction, in the overwhelming
   * majority of real-world cases. Picking "most recent by date" here (as this used to) let exactly such a
   * bad entry silently become the vehicle's "current" mileage — which could flip an already-DUE
   * mileage-based maintenance task back to not-due, with nothing surfaced to the user. Taking the max
   * instead makes a stray low reading inert for due-status purposes while it's still stored and visible in
   * the vehicle's full odometer history (see vehicleDetail's `odometerObservations`) for the user to spot
   * and, if truly needed (e.g. an odometer replaced after an instrument cluster swap), correct by deleting
   * the bad row directly — there's no product flow for "the car's true mileage went down" today. */
  async latestOdometerMileage(vehicleProfileId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ mileage: schema.odometerObservations.mileage })
      .from(schema.odometerObservations)
      .where(eq(schema.odometerObservations.vehicleProfileId, vehicleProfileId))
      .orderBy(desc(schema.odometerObservations.mileage))
      .limit(1);
    return row?.mileage ?? null;
  }

  /** The vehicle's earliest known odometer reading — the fallback baseline for a "mileage" recurrence rule
   * whose `baselineMileage` is null (see recurrence.ts's own doc comment on that field). Null when the
   * vehicle has no readings at all yet. */
  async earliestOdometerMileage(vehicleProfileId: string): Promise<number | null> {
    const [row] = await this.db
      .select({ mileage: schema.odometerObservations.mileage })
      .from(schema.odometerObservations)
      .where(eq(schema.odometerObservations.vehicleProfileId, vehicleProfileId))
      .orderBy(asc(schema.odometerObservations.observedAtSort))
      .limit(1);
    return row?.mileage ?? null;
  }

  // --- Tires (VEH-007) --------------------------------------------------------------------------------

  async createTire(userId: string, dto: CreateTireDto) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, dto.vehicleProfileId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: dto.vehicleProfileId }, "edit");
    const id = generateId("tire");
    await this.db.insert(schema.tires).values({
      id,
      ownerUserId: userId,
      vehicleProfileId: dto.vehicleProfileId,
      brand: dto.brand ?? null,
      model: dto.model ?? null,
      size: dto.size ?? null,
      installDate: dateOnly(dto.installDateIso),
      installMileage: dto.installMileage ?? null,
      pressureSpecPsi: dto.pressureSpecPsi ?? null,
      warrantyMonths: dto.warrantyMonths ?? null,
      roadHazardWarranty: dto.roadHazardWarranty ?? null,
    });
    return { id };
  }

  private async assertTireAccess(tireId: string, userId: string) {
    const [tire] = await this.db.select().from(schema.tires).where(eq(schema.tires.id, tireId)).limit(1);
    if (!tire) throw new NotFoundException({ code: "TIRE_NOT_FOUND", message: "Tire not found." });
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, tire.vehicleProfileId)).limit(1);
    if (!vehicle) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicle.id }, "edit");
    return tire;
  }

  /** VEH-007 "Track... rotation" — appends to the tire's own `rotationHistory` jsonb array rather than a
   * separate table (see tires' own schema doc comment for why). */
  async recordTireRotation(tireId: string, userId: string, dto: RecordTireRotationDto) {
    const tire = await this.assertTireAccess(tireId, userId);
    const date = dto.dateIso ?? new Date().toISOString().slice(0, 10);
    const history = [...tire.rotationHistory, { date, mileage: dto.mileage ?? null }];
    await this.db.update(schema.tires).set({ rotationHistory: history, updatedAt: new Date() }).where(eq(schema.tires.id, tireId));
  }

  /** VEH-007 "...and replacement" — marks the tire replaced rather than deleting the row, so its install
   * date/mileage/rotation/warranty history stays queryable ("when did I replace these?" needs the OLD
   * tire's record to still exist, not just the new one). */
  async replaceTire(tireId: string, userId: string, dto: ReplaceTireDto) {
    await this.assertTireAccess(tireId, userId);
    const replacedAt = dateOnly(dto.replacedAtIso ?? new Date().toISOString());
    await this.db.update(schema.tires).set({ status: "replaced", replacedAt, updatedAt: new Date() }).where(eq(schema.tires.id, tireId));
  }

  // --- Home assets (HOMEOS-008) ------------------------------------------------------------------------

  async createHomeAsset(userId: string, dto: CreateHomeAssetDto) {
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, dto.propertyProfileId)).limit(1);
    if (!property || property.deletedAt) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
    await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: dto.propertyProfileId }, "edit");
    const id = generateId("homeAsset");
    await this.db.insert(schema.homeAssets).values({
      id,
      ownerUserId: userId,
      propertyProfileId: dto.propertyProfileId,
      label: dto.label,
      category: dto.category ?? null,
      room: dto.room ?? null,
      make: dto.make ?? null,
      model: dto.model ?? null,
      serial: dto.serial ?? null,
      installDate: dateOnly(dto.installDateIso),
    });
    // HOMEOS-008 — same off-request recall check as createVehicle above; a no-op (no matches, no external
    // call made) if the asset has no manufacturer on file yet.
    await this.queue.enqueueRecallCheck({ subjectType: "home_asset", subjectId: id });
    return { id };
  }

  /** HOMEOS-002/HOMEOS-003 "must be editable" — no generic home-asset edit endpoint existed at all before
   * this (only create/delete); this is deliberately narrow (the fields a user would actually revise after
   * the fact) rather than a full replace, mirroring CompleteMaintenanceRuleDto's own "just the fields that
   * change" shape. */
  async updateHomeAsset(homeAssetId: string, userId: string, dto: UpdateHomeAssetDto): Promise<void> {
    const [asset] = await this.db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId)).limit(1);
    if (!asset || asset.deletedAt) throw new NotFoundException({ code: "HOME_ASSET_NOT_FOUND", message: "Home asset not found." });
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, asset.propertyProfileId)).limit(1);
    if (property) await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: property.id }, "edit");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.category !== undefined) patch.category = dto.category;
    if (dto.room !== undefined) patch.room = dto.room;
    if (dto.make !== undefined) patch.make = dto.make;
    if (dto.model !== undefined) patch.model = dto.model;
    if (dto.serial !== undefined) patch.serial = dto.serial;
    if (dto.installDateIso !== undefined) patch.installDate = dateOnly(dto.installDateIso);
    await this.db.update(schema.homeAssets).set(patch).where(eq(schema.homeAssets.id, homeAssetId));
    // A newly set make/model is exactly the "asset has no manufacturer on file yet" case checkHomeAsset's
    // own no-op guard exists for — re-check now that one might have just been added, same reasoning as
    // createHomeAsset's own recall-check-on-create.
    if (dto.make !== undefined || dto.model !== undefined) await this.queue.enqueueRecallCheck({ subjectType: "home_asset", subjectId: homeAssetId });
  }

  /** Home assets have no sharing endpoint (and no resourceType) of their own — access rides on the parent
   * property's grant, same as every other home-asset write in this class. "Manage" on the property covers
   * deleting one of its home assets, consistent with "manage = edit + delete" on the property itself. */
  async deleteHomeAsset(homeAssetId: string, userId: string): Promise<void> {
    const [asset] = await this.db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId)).limit(1);
    if (!asset) throw new NotFoundException({ code: "HOME_ASSET_NOT_FOUND", message: "Home asset not found." });
    if (asset.ownerUserId !== userId && !(await this.sharing.hasGrantAtLeast("property", asset.propertyProfileId, userId, "manage"))) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or someone with manage access can remove this home asset." });
    }
    await this.db.update(schema.homeAssets).set({ deletedAt: new Date() }).where(eq(schema.homeAssets.id, homeAssetId));
  }

  // --- Recall monitoring (VEH-006/HOMEOS-008) -----------------------------------------------------------

  /** The manual "Check for recalls" button — unlike the queued check on create, this runs synchronously:
   * it's one bounded outbound call (SafeUrlFetcher's own 10s timeout — see safe-url-fetcher.ts), and the
   * whole point of a manual trigger is the user seeing the result immediately, not a background job they'd
   * have to poll for. */
  async checkVehicleRecallsNow(vehicleId: string, userId: string) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicleId }, "edit");
    return this.recallMonitor.checkVehicle(vehicleId);
  }

  async checkHomeAssetRecallsNow(homeAssetId: string, userId: string) {
    const [asset] = await this.db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, homeAssetId)).limit(1);
    if (!asset || asset.deletedAt) throw new NotFoundException({ code: "HOME_ASSET_NOT_FOUND", message: "Home asset not found." });
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, asset.propertyProfileId)).limit(1);
    if (property) await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: property.id }, "edit");
    return this.recallMonitor.checkHomeAsset(homeAssetId);
  }

  private async assertRecallMatchAccess(recallMatchId: string, userId: string) {
    const [match] = await this.db.select().from(schema.recallMatches).where(eq(schema.recallMatches.id, recallMatchId)).limit(1);
    if (!match) throw new NotFoundException({ code: "RECALL_MATCH_NOT_FOUND", message: "Recall not found." });
    if (match.vehicleProfileId) {
      const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, match.vehicleProfileId)).limit(1);
      if (vehicle) await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicle.id }, "edit");
    } else if (match.homeAssetId) {
      const [asset] = await this.db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, match.homeAssetId)).limit(1);
      if (asset) {
        const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, asset.propertyProfileId)).limit(1);
        if (property) await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: property.id }, "edit");
      }
    }
    return match;
  }

  /** VEH-006 "Alerts distinguish open, repaired/closed if known, and 'potential match; verify VIN'" — the
   * user's own confirmation that a match genuinely applies (they checked their VIN/serial against the
   * recall notice themselves). RecallMonitorService never sets this status on its own — see its own doc
   * comment. */
  async confirmRecallMatch(recallMatchId: string, userId: string): Promise<void> {
    await this.assertRecallMatchAccess(recallMatchId, userId);
    await this.db.update(schema.recallMatches).set({ status: "open", updatedAt: new Date() }).where(eq(schema.recallMatches.id, recallMatchId));
  }

  /** Marks a recall handled — repaired, or otherwise confirmed not applicable — regardless of whether it
   * was ever promoted to "open" first (a user might resolve a still-"potential_match_verify_vin" recall
   * directly, e.g. "I checked, this doesn't affect my VIN"). */
  async resolveRecallMatch(recallMatchId: string, userId: string): Promise<void> {
    await this.assertRecallMatchAccess(recallMatchId, userId);
    await this.db.update(schema.recallMatches).set({ status: "closed_or_repaired", updatedAt: new Date() }).where(eq(schema.recallMatches.id, recallMatchId));
  }

  // --- VIN decode (VEH-001) ------------------------------------------------------------------------------

  /** Standalone decode — no vehicle needs to exist yet. Used by the "add a vehicle" form: a user types a
   * VIN, this returns suggestions, and the form lets them review/edit before actually submitting the
   * create — VEH-001's own "user confirms" requirement, satisfied by never writing anything here at all. */
  async decodeVinStandalone(dto: DecodeVinDto): Promise<VinDecodeSuggestion> {
    return this.vinDecode.decodeVin(dto.vin);
  }

  /** Decodes and applies to an EXISTING vehicle — the backfill path for a vehicle that already has a VIN on
   * file but was created before decode existed, or whose make/model/year were never filled in. "Apply"
   * means: decoded attributes always get stored (for display — see vehicleProfiles.vinDecodeAttributes'
   * own doc comment), but `make`/`model`/`year` are only ever filled in when the vehicle doesn't already
   * have a value for that specific field — "user correction always outranks a guess," never the reverse.
   * `vinOverride` lets a caller decode a VIN that differs from what's currently stored (e.g. correcting a
   * typo) without a separate "update VIN" endpoint existing yet; it does NOT itself change the stored `vin`
   * column — only the caller's own explicit vehicle-update path should do that. */
  async applyVinDecode(vehicleId: string, userId: string, vinOverride?: string): Promise<{ suggestion: VinDecodeSuggestion; applied: { make: boolean; model: boolean; year: boolean } }> {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicleId }, "edit");
    const vin = vinOverride?.trim() || vehicle.vin;
    if (!vin) throw new BadRequestException({ code: "VIN_REQUIRED", message: "This vehicle has no VIN on file to decode." });
    const suggestion = await this.vinDecode.decodeVin(vin);

    const patch: Record<string, unknown> = { vinDecodedAt: new Date(), updatedAt: new Date() };
    if (suggestion.success) patch.vinDecodeAttributes = suggestion.attributes;
    const applied = { make: false, model: false, year: false };
    if (suggestion.success) {
      if (!vehicle.make && suggestion.make) {
        patch.make = suggestion.make;
        applied.make = true;
      }
      if (!vehicle.model && suggestion.model) {
        patch.model = suggestion.model;
        applied.model = true;
      }
      if (!vehicle.year && suggestion.modelYear) {
        patch.year = suggestion.modelYear;
        applied.year = true;
      }
    }
    await this.db.update(schema.vehicleProfiles).set(patch).where(eq(schema.vehicleProfiles.id, vehicleId));
    // A newly filled make/model/year is exactly checkVehicle's own "no-op without one" guard — re-check now.
    if (applied.make || applied.model || applied.year) await this.queue.enqueueRecallCheck({ subjectType: "vehicle", subjectId: vehicleId });
    return { suggestion, applied };
  }

  // --- Maintenance rules (HOMEOS-004/VEH-003) -------------------------------------------------------------

  /** Resolves + access-checks the vehicle/home-asset a maintenance-rule DTO points at, returning the
   * owner/household to file the row under — mirrors createMaintenanceRecord's identical
   * exactly-one-of-two-parents shape. */
  private async assertMaintenanceRuleSubjectAccess(subject: { vehicleProfileId?: string | null; homeAssetId?: string | null }, userId: string): Promise<{ ownerUserId: string; householdId: string | null }> {
    if (subject.vehicleProfileId) {
      const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, subject.vehicleProfileId)).limit(1);
      if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
      await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: subject.vehicleProfileId }, "edit");
      return { ownerUserId: vehicle.ownerUserId, householdId: vehicle.householdId };
    }
    if (subject.homeAssetId) {
      const [asset] = await this.db.select().from(schema.homeAssets).where(eq(schema.homeAssets.id, subject.homeAssetId)).limit(1);
      if (!asset || asset.deletedAt) throw new NotFoundException({ code: "HOME_ASSET_NOT_FOUND", message: "Home asset not found." });
      const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, asset.propertyProfileId)).limit(1);
      if (!property) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
      await this.assertAssetAccess(property.ownerUserId, property.householdId, userId, { resourceType: "property", resourceId: property.id }, "edit");
      return { ownerUserId: asset.ownerUserId, householdId: property.householdId };
    }
    throw new BadRequestException({ code: "MISSING_SUBJECT", message: "A maintenance rule must belong to a vehicle or a home asset." });
  }

  async createMaintenanceRule(userId: string, dto: CreateMaintenanceRuleDto) {
    const owner = await this.assertMaintenanceRuleSubjectAccess(dto, userId);
    const lastPerformedDate = dateOnly(dto.lastPerformedDateIso);
    const id = generateId("maintenanceRule");
    await this.db.insert(schema.maintenanceRules).values({
      id,
      ownerUserId: owner.ownerUserId,
      vehicleProfileId: dto.vehicleProfileId ?? null,
      homeAssetId: dto.homeAssetId ?? null,
      label: dto.label,
      intervalType: dto.intervalType,
      intervalDays: dto.intervalDays ?? null,
      intervalMiles: dto.intervalMiles ?? null,
      baselineMileage: dto.baselineMileage ?? null,
      lastPerformedDate,
      lastPerformedDateSort: lastPerformedDate?.date ? new Date(`${lastPerformedDate.date}T00:00:00Z`) : null,
      source: "user_added",
      confidenceNote: null,
    });
    return { id };
  }

  /** HOMEOS-004/VEH-003 "Seed a SMALL set of genuinely well-known, generic... maintenance interval
   * defaults" — a one-tap "add this suggested rule" action from `maintenance-rule-templates.ts`'s short,
   * curated list. Always stamps `source: "seeded_generic_guidance"` and copies the template's own honest
   * `confidenceNote` — never presented as this vehicle/asset's actual manufacturer schedule. */
  async createMaintenanceRuleFromTemplate(userId: string, dto: CreateMaintenanceRuleFromTemplateDto) {
    const owner = await this.assertMaintenanceRuleSubjectAccess(dto, userId);
    const template = dto.vehicleProfileId ? findVehicleMaintenanceTemplate(dto.templateKey) : findHomeMaintenanceTemplate(dto.templateKey);
    if (!template) throw new NotFoundException({ code: "TEMPLATE_NOT_FOUND", message: "That maintenance template doesn't exist." });
    const id = generateId("maintenanceRule");
    await this.db.insert(schema.maintenanceRules).values({
      id,
      ownerUserId: owner.ownerUserId,
      vehicleProfileId: dto.vehicleProfileId ?? null,
      homeAssetId: dto.homeAssetId ?? null,
      label: template.label,
      intervalType: template.intervalType,
      intervalDays: template.intervalDays ?? null,
      intervalMiles: template.intervalMiles ?? null,
      source: "seeded_generic_guidance",
      confidenceNote: template.confidenceNote,
    });
    return { id };
  }

  listVehicleMaintenanceTemplates() {
    return VEHICLE_MAINTENANCE_TEMPLATES;
  }

  listHomeMaintenanceTemplates() {
    return HOME_MAINTENANCE_TEMPLATES;
  }

  private async assertMaintenanceRuleAccess(ruleId: string, userId: string) {
    const [rule] = await this.db.select().from(schema.maintenanceRules).where(eq(schema.maintenanceRules.id, ruleId)).limit(1);
    if (!rule || rule.deletedAt) throw new NotFoundException({ code: "MAINTENANCE_RULE_NOT_FOUND", message: "Maintenance rule not found." });
    await this.assertMaintenanceRuleSubjectAccess(rule, userId);
    return rule;
  }

  /** A user can always add/edit/delete/override a rule, seeded or not — editing one clears it to
   * `source: "user_added"` (and drops `confidenceNote`): once someone has typed in their own numbers, this
   * is no longer a generic guess this app is offering, it's their own instruction. */
  async updateMaintenanceRule(ruleId: string, userId: string, dto: UpdateMaintenanceRuleDto): Promise<void> {
    await this.assertMaintenanceRuleAccess(ruleId, userId);
    const patch: Record<string, unknown> = { updatedAt: new Date(), source: "user_added", confidenceNote: null };
    if (dto.label !== undefined) patch.label = dto.label;
    if (dto.intervalType !== undefined) patch.intervalType = dto.intervalType;
    if (dto.intervalDays !== undefined) patch.intervalDays = dto.intervalDays;
    if (dto.intervalMiles !== undefined) patch.intervalMiles = dto.intervalMiles;
    if (dto.baselineMileage !== undefined) patch.baselineMileage = dto.baselineMileage;
    await this.db.update(schema.maintenanceRules).set(patch).where(eq(schema.maintenanceRules.id, ruleId));
  }

  async deleteMaintenanceRule(ruleId: string, userId: string): Promise<void> {
    await this.assertMaintenanceRuleAccess(ruleId, userId);
    await this.db.update(schema.maintenanceRules).set({ deletedAt: new Date() }).where(eq(schema.maintenanceRules.id, ruleId));
  }

  /** "Mark done" — re-anchors the rule so its next due point counts forward from now (or a supplied past
   * date/mileage), mirroring ScheduleService.completeTask's identical mileage-recurrence re-anchoring. When
   * `performedMileage` is omitted for a mileage-aware rule, this falls back to the vehicle's own latest
   * odometer reading if one exists — the same "use what we actually know" fallback
   * AssetsService.latestOdometerMileage already documents for the recurrence engine's mileage rules. */
  async completeMaintenanceRule(ruleId: string, userId: string, dto: CompleteMaintenanceRuleDto): Promise<void> {
    const rule = await this.assertMaintenanceRuleAccess(ruleId, userId);
    const performedDate = dateOnly(dto.performedDateIso ?? new Date().toISOString())!;
    const patch: Record<string, unknown> = {
      lastPerformedDate: performedDate,
      lastPerformedDateSort: new Date(`${performedDate.date}T00:00:00Z`),
      updatedAt: new Date(),
    };
    if (rule.intervalType !== "calendar") {
      if (dto.performedMileage != null) {
        patch.baselineMileage = dto.performedMileage;
      } else if (rule.vehicleProfileId) {
        const current = await this.latestOdometerMileage(rule.vehicleProfileId);
        if (current != null) patch.baselineMileage = current;
      }
    }
    await this.db.update(schema.maintenanceRules).set(patch).where(eq(schema.maintenanceRules.id, ruleId));
  }

  // --- Registration / inspection / emissions records (VEH-004) --------------------------------------------

  async createRegistrationRecord(userId: string, dto: CreateRegistrationRecordDto) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, dto.vehicleProfileId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: dto.vehicleProfileId }, "edit");
    const renewalDueDate = dateOnly(dto.renewalDueDateIso);
    const id = generateId("registrationRecord");
    await this.db.insert(schema.registrationRecords).values({
      id,
      ownerUserId: userId,
      vehicleProfileId: dto.vehicleProfileId,
      recordType: dto.recordType,
      jurisdiction: dto.jurisdiction ?? null,
      renewalDueDate,
      renewalDueDateSort: renewalDueDate?.date ? new Date(`${renewalDueDate.date}T00:00:00Z`) : null,
      reminderLeadDays: dto.reminderLeadDays,
      notes: dto.notes ?? null,
    });
    return { id };
  }

  private async assertRegistrationRecordAccess(recordId: string, userId: string) {
    const [record] = await this.db.select().from(schema.registrationRecords).where(eq(schema.registrationRecords.id, recordId)).limit(1);
    if (!record || record.deletedAt) throw new NotFoundException({ code: "REGISTRATION_RECORD_NOT_FOUND", message: "Registration record not found." });
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, record.vehicleProfileId)).limit(1);
    if (vehicle) await this.assertAssetAccess(vehicle.ownerUserId, vehicle.householdId, userId, { resourceType: "vehicle", resourceId: vehicle.id }, "edit");
    return record;
  }

  async updateRegistrationRecord(recordId: string, userId: string, dto: UpdateRegistrationRecordDto): Promise<void> {
    await this.assertRegistrationRecordAccess(recordId, userId);
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.recordType !== undefined) patch.recordType = dto.recordType;
    if (dto.jurisdiction !== undefined) patch.jurisdiction = dto.jurisdiction;
    if (dto.renewalDueDateIso !== undefined) {
      const renewalDueDate = dateOnly(dto.renewalDueDateIso);
      patch.renewalDueDate = renewalDueDate;
      patch.renewalDueDateSort = renewalDueDate?.date ? new Date(`${renewalDueDate.date}T00:00:00Z`) : null;
    }
    if (dto.reminderLeadDays !== undefined) patch.reminderLeadDays = dto.reminderLeadDays;
    if (dto.notes !== undefined) patch.notes = dto.notes;
    await this.db.update(schema.registrationRecords).set(patch).where(eq(schema.registrationRecords.id, recordId));
  }

  async deleteRegistrationRecord(recordId: string, userId: string): Promise<void> {
    await this.assertRegistrationRecordAccess(recordId, userId);
    await this.db.update(schema.registrationRecords).set({ deletedAt: new Date() }).where(eq(schema.registrationRecords.id, recordId));
  }

  /** VEH-004 "Renewal/inspection completion rolls forward based on new evidence or user confirmation" —
   * see RenewRegistrationRecordDtoSchema's own doc comment on why `newDueDateIso` is required rather than
   * optional. */
  async renewRegistrationRecord(recordId: string, userId: string, dto: RenewRegistrationRecordDto): Promise<void> {
    await this.assertRegistrationRecordAccess(recordId, userId);
    const renewedDate = dateOnly(dto.renewedDateIso ?? new Date().toISOString());
    const newDueDate = dateOnly(dto.newDueDateIso)!;
    await this.db
      .update(schema.registrationRecords)
      .set({
        status: "active",
        lastRenewedDate: renewedDate,
        renewalDueDate: newDueDate,
        renewalDueDateSort: new Date(`${newDueDate.date}T00:00:00Z`),
        updatedAt: new Date(),
      })
      .where(eq(schema.registrationRecords.id, recordId));
  }

  private async assertHouseholdMember(householdId: string, userId: string): Promise<void> {
    const [membership] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, householdId), eq(schema.householdMemberships.userId, userId), eq(schema.householdMemberships.status, "active")))
      .limit(1);
    if (!membership) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
  }

  // ---------------------------------------------------------------------------------------------------
  // §40.1/40.2 identity resolution — vehicle merge candidates + reversible merge/unmerge. Mirrors
  // PeopleService's PEO-002 section exactly (see its own class-level doc comment): merge is scoped to the
  // caller's OWN vehicles (not an admin-wide catalog the way AdminService.mergeMerchants is), so ownership —
  // not a role — is the authorization boundary here too.
  // ---------------------------------------------------------------------------------------------------

  /**
   * §40.1 "Vehicle: VIN [is the strong identity signal]... VIN exact; otherwise user confirmation for
   * potentially distinct vehicles." Deliberately the ONLY signal this checks — no fuzzy make/model/year
   * grouping — per this codebase's precision-first dedup discipline (mirrors
   * PeopleService.findMergeCandidates' own doc comment: "a candidate group always comes with a concrete,
   * explainable reason a human can verify at a glance"). A vehicle with no VIN on file is never offered as a
   * candidate at all; §40.2's own "false non-merge is preferable to incorrectly combining two ... vehicles"
   * bar rules out ever inferring a match from make/model/year alone.
   */
  async findVehicleMergeCandidates(userId: string) {
    const vehicles = await this.db
      .select()
      .from(schema.vehicleProfiles)
      .where(and(eq(schema.vehicleProfiles.ownerUserId, userId), isNull(schema.vehicleProfiles.deletedAt), isNull(schema.vehicleProfiles.mergedIntoVehicleId)));
    if (vehicles.length < 2) return [];
    const groups = new Map<string, typeof vehicles>();
    for (const vehicle of vehicles) {
      if (!vehicle.vin) continue;
      const key = normalizeVin(vehicle.vin);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(vehicle);
      else groups.set(key, [vehicle]);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((vehicles) => ({ reason: "matching_vin" as const, vehicleIds: vehicles.map((v) => v.id), vehicles }));
  }

  async listVehicleMergeLineage(userId: string) {
    return this.db
      .select()
      .from(schema.vehicleMergeLineage)
      .innerJoin(schema.vehicleProfiles, eq(schema.vehicleProfiles.id, schema.vehicleMergeLineage.survivingVehicleId))
      .where(eq(schema.vehicleProfiles.ownerUserId, userId))
      .orderBy(desc(schema.vehicleMergeLineage.mergedAt));
  }

  /**
   * Reversible merge (§40.2 "Merge operations ... preserve source mappings") — mirrors
   * PeopleService.mergePeople's snapshot+repoint+lineage shape exactly, adapted to this domain's six
   * satellite tables (maintenanceRecords/odometerObservations/tires/recallMatches/maintenanceRules/
   * registrationRecords) plus `warranties` (see vehicleMergeLineage's own schema doc comment for why
   * warranties is included even though it isn't one of the tables VEH-001/VEH-006/VEH-007/VEH-003/VEH-004
   * introduced in this pass). Both vehicles must be owned by the SAME caller, same reasoning as
   * PeopleService.mergePeople.
   */
  async mergeVehicles(survivingVehicleId: string, mergedVehicleId: string, actorUserId: string) {
    if (survivingVehicleId === mergedVehicleId) {
      throw new BadRequestException({ code: "SAME_VEHICLE", message: "Can't merge a vehicle into itself." });
    }
    const [surviving] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, survivingVehicleId)).limit(1);
    const [merged] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, mergedVehicleId)).limit(1);
    if (!surviving || !merged || surviving.deletedAt || merged.deletedAt) {
      throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "One or both vehicles were not found." });
    }
    if (surviving.ownerUserId !== actorUserId || merged.ownerUserId !== actorUserId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only merge your own vehicles." });
    }
    if (merged.mergedIntoVehicleId) throw new BadRequestException({ code: "ALREADY_MERGED", message: "That vehicle was already merged into another one." });

    const lineageId = generateId("vehicleMergeLineage");
    const repointed = await this.db.transaction(async (tx) => {
      const [maintenanceRows, odometerRows, tireRows, recallRows, ruleRows, registrationRows, warrantyRows] = await Promise.all([
        tx.select({ id: schema.maintenanceRecords.id }).from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.vehicleProfileId, mergedVehicleId)),
        tx.select({ id: schema.odometerObservations.id }).from(schema.odometerObservations).where(eq(schema.odometerObservations.vehicleProfileId, mergedVehicleId)),
        tx.select({ id: schema.tires.id }).from(schema.tires).where(eq(schema.tires.vehicleProfileId, mergedVehicleId)),
        tx.select({ id: schema.recallMatches.id }).from(schema.recallMatches).where(eq(schema.recallMatches.vehicleProfileId, mergedVehicleId)),
        tx.select({ id: schema.maintenanceRules.id }).from(schema.maintenanceRules).where(eq(schema.maintenanceRules.vehicleProfileId, mergedVehicleId)),
        tx.select({ id: schema.registrationRecords.id }).from(schema.registrationRecords).where(eq(schema.registrationRecords.vehicleProfileId, mergedVehicleId)),
        tx.select({ id: schema.warranties.id }).from(schema.warranties).where(eq(schema.warranties.vehicleProfileId, mergedVehicleId)),
      ]);
      const maintenanceRecordIds = maintenanceRows.map((r) => r.id);
      const odometerObservationIds = odometerRows.map((r) => r.id);
      const tireIds = tireRows.map((r) => r.id);
      const recallMatchIds = recallRows.map((r) => r.id);
      const maintenanceRuleIds = ruleRows.map((r) => r.id);
      const registrationRecordIds = registrationRows.map((r) => r.id);
      const warrantyIds = warrantyRows.map((r) => r.id);

      await tx.update(schema.maintenanceRecords).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.maintenanceRecords.vehicleProfileId, mergedVehicleId));
      await tx.update(schema.odometerObservations).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.odometerObservations.vehicleProfileId, mergedVehicleId));
      await tx.update(schema.tires).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.tires.vehicleProfileId, mergedVehicleId));
      await tx.update(schema.recallMatches).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.recallMatches.vehicleProfileId, mergedVehicleId));
      await tx.update(schema.maintenanceRules).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.maintenanceRules.vehicleProfileId, mergedVehicleId));
      await tx.update(schema.registrationRecords).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.registrationRecords.vehicleProfileId, mergedVehicleId));
      await tx.update(schema.warranties).set({ vehicleProfileId: survivingVehicleId }).where(eq(schema.warranties.vehicleProfileId, mergedVehicleId));
      // "user correction always outranks a guess" (VinDecodeService's own discipline, applied here too) —
      // only fills a gap on the survivor, never overwrites a value it already has.
      await tx
        .update(schema.vehicleProfiles)
        .set({
          vin: surviving.vin ?? merged.vin,
          make: surviving.make ?? merged.make,
          model: surviving.model ?? merged.model,
          year: surviving.year ?? merged.year,
          updatedAt: new Date(),
        })
        .where(eq(schema.vehicleProfiles.id, survivingVehicleId));
      await tx.update(schema.vehicleProfiles).set({ mergedIntoVehicleId: survivingVehicleId, updatedAt: new Date() }).where(eq(schema.vehicleProfiles.id, mergedVehicleId));

      await tx.insert(schema.vehicleMergeLineage).values({
        id: lineageId,
        survivingVehicleId,
        mergedVehicleId,
        mergedVehicleSnapshot: merged,
        repointedMaintenanceRecordIds: maintenanceRecordIds,
        repointedOdometerObservationIds: odometerObservationIds,
        repointedTireIds: tireIds,
        repointedRecallMatchIds: recallMatchIds,
        repointedMaintenanceRuleIds: maintenanceRuleIds,
        repointedRegistrationRecordIds: registrationRecordIds,
        repointedWarrantyIds: warrantyIds,
        actorUserId,
      });

      return { maintenanceRecordIds, odometerObservationIds, tireIds, recallMatchIds, maintenanceRuleIds, registrationRecordIds, warrantyIds };
    });

    return {
      lineageId,
      repointedMaintenanceRecordCount: repointed.maintenanceRecordIds.length,
      repointedOdometerObservationCount: repointed.odometerObservationIds.length,
      repointedTireCount: repointed.tireIds.length,
      repointedRecallMatchCount: repointed.recallMatchIds.length,
      repointedMaintenanceRuleCount: repointed.maintenanceRuleIds.length,
      repointedRegistrationRecordCount: repointed.registrationRecordIds.length,
      repointedWarrantyCount: repointed.warrantyIds.length,
    };
  }

  /** Reverses exactly one merge: restores the merged vehicle row and repoints only the rows THAT merge
   * actually moved (mirrors PeopleService.unmergePeople). */
  async unmergeVehicles(lineageId: string, actorUserId: string) {
    const [lineage] = await this.db.select().from(schema.vehicleMergeLineage).where(eq(schema.vehicleMergeLineage.id, lineageId)).limit(1);
    if (!lineage) throw new NotFoundException({ code: "MERGE_NOT_FOUND", message: "That merge record was not found." });
    if (lineage.unmergedAt) throw new BadRequestException({ code: "ALREADY_UNMERGED", message: "That merge was already undone." });
    if (lineage.actorUserId !== actorUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only undo your own merges." });

    await this.db.transaction(async (tx) => {
      await tx.update(schema.vehicleProfiles).set({ mergedIntoVehicleId: null, updatedAt: new Date() }).where(eq(schema.vehicleProfiles.id, lineage.mergedVehicleId));
      if (lineage.repointedMaintenanceRecordIds.length > 0) {
        await tx.update(schema.maintenanceRecords).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.maintenanceRecords.id, lineage.repointedMaintenanceRecordIds));
      }
      if (lineage.repointedOdometerObservationIds.length > 0) {
        await tx.update(schema.odometerObservations).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.odometerObservations.id, lineage.repointedOdometerObservationIds));
      }
      if (lineage.repointedTireIds.length > 0) {
        await tx.update(schema.tires).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.tires.id, lineage.repointedTireIds));
      }
      if (lineage.repointedRecallMatchIds.length > 0) {
        await tx.update(schema.recallMatches).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.recallMatches.id, lineage.repointedRecallMatchIds));
      }
      if (lineage.repointedMaintenanceRuleIds.length > 0) {
        await tx.update(schema.maintenanceRules).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.maintenanceRules.id, lineage.repointedMaintenanceRuleIds));
      }
      if (lineage.repointedRegistrationRecordIds.length > 0) {
        await tx.update(schema.registrationRecords).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.registrationRecords.id, lineage.repointedRegistrationRecordIds));
      }
      if (lineage.repointedWarrantyIds.length > 0) {
        await tx.update(schema.warranties).set({ vehicleProfileId: lineage.mergedVehicleId }).where(inArray(schema.warranties.id, lineage.repointedWarrantyIds));
      }
      await tx.update(schema.vehicleMergeLineage).set({ unmergedAt: new Date() }).where(eq(schema.vehicleMergeLineage.id, lineageId));
    });

    return {
      restoredMaintenanceRecordCount: lineage.repointedMaintenanceRecordIds.length,
      restoredOdometerObservationCount: lineage.repointedOdometerObservationIds.length,
      restoredTireCount: lineage.repointedTireIds.length,
      restoredRecallMatchCount: lineage.repointedRecallMatchIds.length,
      restoredMaintenanceRuleCount: lineage.repointedMaintenanceRuleIds.length,
      restoredRegistrationRecordCount: lineage.repointedRegistrationRecordIds.length,
      restoredWarrantyCount: lineage.repointedWarrantyIds.length,
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // §40.1/40.2 identity resolution — property merge candidates + reversible merge/unmerge. Same shape as
  // the vehicle section above.
  // ---------------------------------------------------------------------------------------------------

  /**
   * §40.1 "Property: normalized full address + user property identity [is the strong identity signal]...
   * User confirmation when unit/parcel ambiguity exists." No geocoding provider is wired up in this
   * codebase, so this is an exact match on a normalized address string (trim/lowercase/punctuation-
   * collapsed — see normalizeAddress's own doc comment) rather than a geocoded coordinate match — still
   * precision-first: "123 Main St Apt 2" and "123 Main St Apt 3" normalize to two different keys and are
   * never offered as a candidate pair. A property with no address on file is never offered as a candidate at
   * all — matching by label alone ("Home" / "Home") would be exactly the "loose similarity" §40.2 explicitly
   * rules out.
   */
  async findPropertyMergeCandidates(userId: string) {
    const properties = await this.db
      .select()
      .from(schema.propertyProfiles)
      .where(and(eq(schema.propertyProfiles.ownerUserId, userId), isNull(schema.propertyProfiles.deletedAt), isNull(schema.propertyProfiles.mergedIntoPropertyId)));
    if (properties.length < 2) return [];
    const groups = new Map<string, typeof properties>();
    for (const property of properties) {
      if (!property.address) continue;
      const key = normalizeAddress(property.address);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(property);
      else groups.set(key, [property]);
    }
    return [...groups.values()]
      .filter((group) => group.length > 1)
      .map((properties) => ({ reason: "matching_address" as const, propertyIds: properties.map((p) => p.id), properties }));
  }

  async listPropertyMergeLineage(userId: string) {
    return this.db
      .select()
      .from(schema.propertyMergeLineage)
      .innerJoin(schema.propertyProfiles, eq(schema.propertyProfiles.id, schema.propertyMergeLineage.survivingPropertyId))
      .where(eq(schema.propertyProfiles.ownerUserId, userId))
      .orderBy(desc(schema.propertyMergeLineage.mergedAt));
  }

  /**
   * Reversible merge (§40.2) — mirrors mergeVehicles' shape exactly, adapted to properties' two satellite
   * tables (maintenanceRecords/homeAssets — repointing a home asset's `propertyProfileId` automatically
   * carries its own child rows, recallMatches/maintenanceRules keyed by `homeAssetId`, along with it) plus
   * `warranties`.
   */
  async mergeProperties(survivingPropertyId: string, mergedPropertyId: string, actorUserId: string) {
    if (survivingPropertyId === mergedPropertyId) {
      throw new BadRequestException({ code: "SAME_PROPERTY", message: "Can't merge a property into itself." });
    }
    const [surviving] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, survivingPropertyId)).limit(1);
    const [merged] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, mergedPropertyId)).limit(1);
    if (!surviving || !merged || surviving.deletedAt || merged.deletedAt) {
      throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "One or both properties were not found." });
    }
    if (surviving.ownerUserId !== actorUserId || merged.ownerUserId !== actorUserId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only merge your own properties." });
    }
    if (merged.mergedIntoPropertyId) throw new BadRequestException({ code: "ALREADY_MERGED", message: "That property was already merged into another one." });

    const lineageId = generateId("propertyMergeLineage");
    const repointed = await this.db.transaction(async (tx) => {
      const [maintenanceRows, homeAssetRows, warrantyRows] = await Promise.all([
        tx.select({ id: schema.maintenanceRecords.id }).from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.propertyProfileId, mergedPropertyId)),
        tx.select({ id: schema.homeAssets.id }).from(schema.homeAssets).where(eq(schema.homeAssets.propertyProfileId, mergedPropertyId)),
        tx.select({ id: schema.warranties.id }).from(schema.warranties).where(eq(schema.warranties.propertyProfileId, mergedPropertyId)),
      ]);
      const maintenanceRecordIds = maintenanceRows.map((r) => r.id);
      const homeAssetIds = homeAssetRows.map((r) => r.id);
      const warrantyIds = warrantyRows.map((r) => r.id);

      await tx.update(schema.maintenanceRecords).set({ propertyProfileId: survivingPropertyId }).where(eq(schema.maintenanceRecords.propertyProfileId, mergedPropertyId));
      await tx.update(schema.homeAssets).set({ propertyProfileId: survivingPropertyId }).where(eq(schema.homeAssets.propertyProfileId, mergedPropertyId));
      await tx.update(schema.warranties).set({ propertyProfileId: survivingPropertyId }).where(eq(schema.warranties.propertyProfileId, mergedPropertyId));
      await tx
        .update(schema.propertyProfiles)
        .set({ address: surviving.address ?? merged.address, updatedAt: new Date() })
        .where(eq(schema.propertyProfiles.id, survivingPropertyId));
      await tx.update(schema.propertyProfiles).set({ mergedIntoPropertyId: survivingPropertyId, updatedAt: new Date() }).where(eq(schema.propertyProfiles.id, mergedPropertyId));

      await tx.insert(schema.propertyMergeLineage).values({
        id: lineageId,
        survivingPropertyId,
        mergedPropertyId,
        mergedPropertySnapshot: merged,
        repointedMaintenanceRecordIds: maintenanceRecordIds,
        repointedHomeAssetIds: homeAssetIds,
        repointedWarrantyIds: warrantyIds,
        actorUserId,
      });

      return { maintenanceRecordIds, homeAssetIds, warrantyIds };
    });

    return {
      lineageId,
      repointedMaintenanceRecordCount: repointed.maintenanceRecordIds.length,
      repointedHomeAssetCount: repointed.homeAssetIds.length,
      repointedWarrantyCount: repointed.warrantyIds.length,
    };
  }

  /** Reverses exactly one merge: restores the merged property row and repoints only the rows THAT merge
   * actually moved (mirrors unmergeVehicles above). */
  async unmergeProperties(lineageId: string, actorUserId: string) {
    const [lineage] = await this.db.select().from(schema.propertyMergeLineage).where(eq(schema.propertyMergeLineage.id, lineageId)).limit(1);
    if (!lineage) throw new NotFoundException({ code: "MERGE_NOT_FOUND", message: "That merge record was not found." });
    if (lineage.unmergedAt) throw new BadRequestException({ code: "ALREADY_UNMERGED", message: "That merge was already undone." });
    if (lineage.actorUserId !== actorUserId) throw new ForbiddenException({ code: "NOT_OWNER", message: "You can only undo your own merges." });

    await this.db.transaction(async (tx) => {
      await tx.update(schema.propertyProfiles).set({ mergedIntoPropertyId: null, updatedAt: new Date() }).where(eq(schema.propertyProfiles.id, lineage.mergedPropertyId));
      if (lineage.repointedMaintenanceRecordIds.length > 0) {
        await tx.update(schema.maintenanceRecords).set({ propertyProfileId: lineage.mergedPropertyId }).where(inArray(schema.maintenanceRecords.id, lineage.repointedMaintenanceRecordIds));
      }
      if (lineage.repointedHomeAssetIds.length > 0) {
        await tx.update(schema.homeAssets).set({ propertyProfileId: lineage.mergedPropertyId }).where(inArray(schema.homeAssets.id, lineage.repointedHomeAssetIds));
      }
      if (lineage.repointedWarrantyIds.length > 0) {
        await tx.update(schema.warranties).set({ propertyProfileId: lineage.mergedPropertyId }).where(inArray(schema.warranties.id, lineage.repointedWarrantyIds));
      }
      await tx.update(schema.propertyMergeLineage).set({ unmergedAt: new Date() }).where(eq(schema.propertyMergeLineage.id, lineageId));
    });

    return {
      restoredMaintenanceRecordCount: lineage.repointedMaintenanceRecordIds.length,
      restoredHomeAssetCount: lineage.repointedHomeAssetIds.length,
      restoredWarrantyCount: lineage.repointedWarrantyIds.length,
    };
  }

  /**
   * `grant`, when passed, additionally honors a direct resourceGrant on that specific property/vehicle/pet
   * — see SharingService's own doc comment. Optional since maintenance records (which also call this via
   * their parent property/vehicle) have no sharing endpoint of their own.
   *
   * SHARE-001 enforcement — `requiredRight` (default "view") lets write call sites (createMaintenanceRecord,
   * recordOdometerObservation, createTire, etc.) demand "edit" instead of just any active grant; before this
   * pass those call sites passed no `grant` at all, so a grantee could never reach any of them regardless of
   * right — the flip side of the "view grant can still write" gap this pass closes elsewhere.
   */
  private async assertAssetAccess(
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
      // §35 SHARE-007 "access_audit" — same reasoning as PetsService.assertPetAccess/PeopleService.
      // assertAccess: this gate calls hasGrantAtLeast directly (it needs the right, not just "any active
      // grant"), so it can't rely on SharingService.hasActiveGrant's own built-in logging.
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

  // --- Object sharing (Phase 2 §52.2 SHARE-001/SHARE-002) --------------------------------------------
  // Properties and vehicles both have a sensitivity/visibility column (packages/db/src/schema/assets.ts)
  // — same public-link sensitivity gate as DocumentsService, unlike lists/purchases which have none. Same
  // shape as DocumentsService/ListsService/CommerceService's grant/share-link endpoints, see
  // SharingService's own doc comment.

  /** SHARE-001 "manage = edit + delete + can grant/revoke others' access" — same reasoning as
   * ListsService.assertOwnedOrManagedListForSharing. */
  private async assertOwnedOrManagedPropertyForSharing(propertyId: string, userId: string) {
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId)).limit(1);
    if (!property || property.deletedAt) throw new NotFoundException({ code: "PROPERTY_NOT_FOUND", message: "Property not found." });
    if (property.ownerUserId === userId) return property;
    if (await this.sharing.hasGrantAtLeast("property", propertyId, userId, "manage")) return property;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or a manager can share this property." });
  }

  private async assertOwnedOrManagedVehicleForSharing(vehicleId: string, userId: string) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "VEHICLE_NOT_FOUND", message: "Vehicle not found." });
    if (vehicle.ownerUserId === userId) return vehicle;
    if (await this.sharing.hasGrantAtLeast("vehicle", vehicleId, userId, "manage")) return vehicle;
    throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner or a manager can share this vehicle." });
  }

  private assertPublicLinkAllowed(sensitivity: string, resourceLabel: "property" | "vehicle"): void {
    // HH-002 Permissions: "High-sensitivity categories can disallow public links." Same gate as
    // DocumentsService.createShareLink — a home address or a VIN at "highly_sensitive"/"secret" shouldn't
    // get an unauthenticated, internet-reachable link; a direct grant (unrestricted by sensitivity, since
    // it targets one named Veynlo account) is still available for that case.
    if (sensitivity === "highly_sensitive" || sensitivity === "secret") {
      throw new ForbiddenException({
        code: "SENSITIVITY_BLOCKS_PUBLIC_LINK",
        message: `This ${resourceLabel}'s sensitivity level doesn't allow public share links. Share it directly with someone's Veynlo account instead.`,
      });
    }
  }

  async createPropertyGrant(propertyId: string, requestingUserId: string, granteeEmail: string, expiresInDays?: number, right: ResourceGrantRight = "view", message?: string): Promise<{ id: string }> {
    await this.assertOwnedOrManagedPropertyForSharing(propertyId, requestingUserId);
    return this.sharing.createResourceGrant("property", propertyId, requestingUserId, granteeEmail, expiresInDays, right, message);
  }

  async listPropertyGrants(propertyId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPropertyForSharing(propertyId, requestingUserId);
    return this.sharing.listResourceGrants("property", propertyId);
  }

  async createPropertyShareLink(propertyId: string, requestingUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    const property = await this.assertOwnedOrManagedPropertyForSharing(propertyId, requestingUserId);
    this.assertPublicLinkAllowed(property.sensitivity, "property");
    return this.sharing.createShareLink("property", propertyId, requestingUserId, dto);
  }

  async listPropertyShareLinks(propertyId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPropertyForSharing(propertyId, requestingUserId);
    return this.sharing.listShareLinks("property", propertyId);
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listPropertyAccessEvents(propertyId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPropertyForSharing(propertyId, requestingUserId);
    return this.sharing.listAccessEvents("property", propertyId);
  }

  /** SHARE-001 "preview exactly what recipient will see" — reuses publicPropertyContent. */
  async propertySharePreview(propertyId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedPropertyForSharing(propertyId, requestingUserId);
    return this.publicPropertyContent(propertyId);
  }

  /** Public, unauthenticated redemption content for a property share link. */
  async publicPropertyContent(propertyId: string) {
    const [property] = await this.db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId)).limit(1);
    if (!property || property.deletedAt) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    const maintenance = await this.db
      .select({ description: schema.maintenanceRecords.description, serviceDate: schema.maintenanceRecords.serviceDate, costMinorUnits: schema.maintenanceRecords.costMinorUnits, costCurrency: schema.maintenanceRecords.costCurrency })
      .from(schema.maintenanceRecords)
      .where(eq(schema.maintenanceRecords.propertyProfileId, propertyId))
      .orderBy(desc(schema.maintenanceRecords.serviceDateSort));
    return { label: property.label, propertyType: property.propertyType, address: property.address, moveInDate: property.moveInDate, maintenance };
  }

  async createVehicleGrant(vehicleId: string, requestingUserId: string, granteeEmail: string, expiresInDays?: number, right: ResourceGrantRight = "view", message?: string): Promise<{ id: string }> {
    await this.assertOwnedOrManagedVehicleForSharing(vehicleId, requestingUserId);
    return this.sharing.createResourceGrant("vehicle", vehicleId, requestingUserId, granteeEmail, expiresInDays, right, message);
  }

  async listVehicleGrants(vehicleId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedVehicleForSharing(vehicleId, requestingUserId);
    return this.sharing.listResourceGrants("vehicle", vehicleId);
  }

  async createVehicleShareLink(vehicleId: string, requestingUserId: string, dto: CreateShareLinkDto): Promise<{ id: string; token: string }> {
    const vehicle = await this.assertOwnedOrManagedVehicleForSharing(vehicleId, requestingUserId);
    this.assertPublicLinkAllowed(vehicle.sensitivity, "vehicle");
    return this.sharing.createShareLink("vehicle", vehicleId, requestingUserId, dto);
  }

  async listVehicleShareLinks(vehicleId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedVehicleForSharing(vehicleId, requestingUserId);
    return this.sharing.listShareLinks("vehicle", vehicleId);
  }

  /** §35 SHARE-007 "access history" — see SharingService.listAccessEvents' own doc comment. */
  async listVehicleAccessEvents(vehicleId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedVehicleForSharing(vehicleId, requestingUserId);
    return this.sharing.listAccessEvents("vehicle", vehicleId);
  }

  /** SHARE-001 "preview exactly what recipient will see" — reuses publicVehicleContent (e.g. so an owner
   * can see live that the VIN is omitted before they ever create a link). */
  async vehicleSharePreview(vehicleId: string, requestingUserId: string) {
    await this.assertOwnedOrManagedVehicleForSharing(vehicleId, requestingUserId);
    return this.publicVehicleContent(vehicleId);
  }

  /** Public, unauthenticated redemption content for a vehicle share link. Deliberately omits `vin` even
   * though the sensitivity gate above already blocks a "highly_sensitive"/"secret" vehicle from getting a
   * public link at all: a VIN is uniquely identifying and useful for fraud/theft even on an ordinary
   * "sensitive"-tier vehicle, and nothing about "share this vehicle's maintenance history with someone"
   * requires exposing it — a direct grant (an actual named Veynlo account) still sees the full profile
   * via vehicleDetail. */
  async publicVehicleContent(vehicleId: string) {
    const [vehicle] = await this.db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId)).limit(1);
    if (!vehicle || vehicle.deletedAt) throw new NotFoundException({ code: "SHARE_LINK_NOT_FOUND", message: "This link is invalid or has expired." });
    const maintenance = await this.db
      .select({ description: schema.maintenanceRecords.description, serviceDate: schema.maintenanceRecords.serviceDate, costMinorUnits: schema.maintenanceRecords.costMinorUnits, costCurrency: schema.maintenanceRecords.costCurrency })
      .from(schema.maintenanceRecords)
      .where(eq(schema.maintenanceRecords.vehicleProfileId, vehicleId))
      .orderBy(desc(schema.maintenanceRecords.serviceDateSort));
    return { label: vehicle.label, make: vehicle.make, model: vehicle.model, year: vehicle.year, purchaseDate: vehicle.purchaseDate, maintenance };
  }

  /** True when `userId` is the owner of the given property/vehicle — used only by the revoke callbacks
   * below, which only have a resourceType/resourceId, not an already-loaded row. */
  private async isOwnedAsset(resourceType: string, resourceId: string, userId: string): Promise<boolean> {
    if (resourceType === "property") {
      const [property] = await this.db.select({ ownerUserId: schema.propertyProfiles.ownerUserId }).from(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, resourceId)).limit(1);
      return property?.ownerUserId === userId;
    }
    if (resourceType === "vehicle") {
      const [vehicle] = await this.db.select({ ownerUserId: schema.vehicleProfiles.ownerUserId }).from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, resourceId)).limit(1);
      return vehicle?.ownerUserId === userId;
    }
    return false;
  }

  /**
   * No resourceType needed for the base case — a grant/link row already carries who created it, and
   * revocation doesn't care whether it points at a property or a vehicle (same reasoning as
   * SharingService's own doc comment on revokeResourceGrant/revokeShareLink). One shared pair of methods
   * covers both controller routes (`properties/grants/:grantId` and `vehicles/grants/:grantId`, etc).
   * SHARE-001 "manage ... can revoke others' access" — the callback additionally authorizes the current
   * owner or any "manage"-right grantee on whichever resource the grant/link actually points at, not just
   * whoever originally created it.
   */
  async revokeResourceGrant(grantId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeResourceGrant(grantId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "property" && resourceType !== "vehicle") return false;
      return (await this.sharing.hasGrantAtLeast(resourceType, resourceId, requestingUserId, "manage")) || (await this.isOwnedAsset(resourceType, resourceId, requestingUserId));
    });
  }

  async revokeShareLink(linkId: string, requestingUserId: string): Promise<void> {
    return this.sharing.revokeShareLink(linkId, requestingUserId, async (resourceType, resourceId) => {
      if (resourceType !== "property" && resourceType !== "vehicle") return false;
      return (await this.sharing.hasGrantAtLeast(resourceType, resourceId, requestingUserId, "manage")) || (await this.isOwnedAsset(resourceType, resourceId, requestingUserId));
    });
  }
}
