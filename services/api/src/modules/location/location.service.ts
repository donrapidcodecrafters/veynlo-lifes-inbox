import { ForbiddenException, Inject, Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { generateId, estimateTravelTime, extractPlaceCandidate } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HouseholdService } from "../household/household.service";
import { ResurfacingService } from "../memories/resurfacing.service";
import type {
  CreatePlaceDto,
  UpdatePlaceDto,
  CreateGeofenceDto,
  UpdateGeofenceDto,
  CreateContextRuleDto,
  UpdateContextRuleDto,
  RecordGeofenceEventDto,
  UpsertLocationPermissionStateDto,
  EstimateTravelTimeDto,
} from "./dto";

/**
 * Phase 3 §30 "Location & Context" (LOC-003/004/005 buildable subset — see this module's own scoping
 * notes on LOC-004/LOC-005 below; LOC-006 is a boundary, not a feature, and is what this whole service is
 * built to respect rather than something with its own endpoints).
 *
 * LOC-006 verification, re-stated at the service layer (the schema-level guarantee lives in
 * packages/db/src/schema/location.ts's doc comment): every write path in this service either (a) creates
 * a `places`/`geofences`/`context_rules` row the user explicitly authored (metadata, not tracking), or
 * (b) records a single discrete `geofence_events` row containing only `geofenceId`/`triggerKind`/
 * `occurredAt` — never a coordinate, never anything written on any cadence other than "the OS actually
 * fired a region the user themselves registered." There is no method on this service that accepts or
 * stores a raw device position, and no polling/interval-driven write path exists anywhere here.
 */
@Injectable()
export class LocationService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HouseholdService) private readonly households: HouseholdService,
    @Inject(ResurfacingService) private readonly resurfacing: ResurfacingService,
  ) {}

  // Same shape as AssetsService's identical helper — reuses the existing `commerce:read` delegation
  // scope rather than adding a new one to CAREGIVER_DELEGATION_SCOPES for one Phase 3 feature area.
  private async ownerOrDelegatedHousehold(userId: string, ownerCol: AnyPgColumn, householdCol: AnyPgColumn) {
    const [delegatedIds, memberIds] = await Promise.all([
      this.households.delegatedHouseholdIds(userId, "commerce:read"),
      this.households.activeHouseholdIds(userId),
    ]);
    const householdIds = [...new Set([...delegatedIds, ...memberIds])];
    return householdIds.length > 0 ? or(eq(ownerCol, userId), inArray(householdCol, householdIds))! : eq(ownerCol, userId);
  }

  private async assertHouseholdMember(householdId: string, userId: string): Promise<void> {
    const [membership] = await this.db
      .select()
      .from(schema.householdMemberships)
      .where(
        and(
          eq(schema.householdMemberships.householdId, householdId),
          eq(schema.householdMemberships.userId, userId),
          eq(schema.householdMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!membership) throw new ForbiddenException({ code: "NOT_HOUSEHOLD_MEMBER", message: "You're not an active member of that household." });
  }

  // --- Places (LOC-001/LOC-005) -------------------------------------------

  async listPlaces(userId: string) {
    const condition = await this.ownerOrDelegatedHousehold(userId, schema.places.ownerUserId, schema.places.householdId);
    return this.db
      .select()
      .from(schema.places)
      .where(and(isNull(schema.places.deletedAt), condition))
      .orderBy(asc(schema.places.label));
  }

  async createPlace(userId: string, dto: CreatePlaceDto) {
    if (dto.householdId) await this.assertHouseholdMember(dto.householdId, userId);
    const id = generateId("place");
    await this.db.insert(schema.places).values({
      id,
      ownerUserId: userId,
      householdId: dto.householdId ?? null,
      label: dto.label,
      address: dto.address ?? null,
      lat: dto.lat ?? null,
      lng: dto.lng ?? null,
      source: "manual",
    });
    return { id };
  }

  /**
   * LOC-005 "Place from capture" — pure extraction, saves nothing. The caller (a capture/share-intent
   * flow) shows this as a pre-filled "Save as place?" suggestion; the user still explicitly saves it via
   * `createPlace`. See `packages/core/src/util/place-extraction.ts` for exactly what is and isn't
   * recognized (maps-link coordinates and plain street addresses; no geocoding of a bare business name —
   * no geocoding provider is configured in this environment).
   */
  extractPlaceCandidate(text: string) {
    return extractPlaceCandidate(text);
  }

  private async ownedOrHouseholdPlace(placeId: string, userId: string) {
    const [place] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId)).limit(1);
    if (!place || place.deletedAt) throw new NotFoundException({ code: "PLACE_NOT_FOUND", message: "Place not found." });
    if (place.ownerUserId === userId) return place;
    if (place.householdId) {
      const householdIds = [
        ...(await this.households.delegatedHouseholdIds(userId, "commerce:read")),
        ...(await this.households.activeHouseholdIds(userId)),
      ];
      if (householdIds.includes(place.householdId)) return place;
    }
    throw new ForbiddenException({ code: "NOT_AUTHORIZED", message: "You don't have access to this place." });
  }

  async updatePlace(placeId: string, userId: string, dto: UpdatePlaceDto) {
    const place = await this.ownedOrHouseholdPlace(placeId, userId);
    if (place.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner can edit this place." });
    await this.db
      .update(schema.places)
      .set({
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.lat !== undefined ? { lat: dto.lat } : {}),
        ...(dto.lng !== undefined ? { lng: dto.lng } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.places.id, placeId));
    return { id: placeId };
  }

  async deletePlace(placeId: string, userId: string): Promise<void> {
    const [place] = await this.db.select().from(schema.places).where(eq(schema.places.id, placeId)).limit(1);
    if (!place) throw new NotFoundException({ code: "PLACE_NOT_FOUND", message: "Place not found." });
    if (place.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner can remove this place." });
    await this.db.update(schema.places).set({ deletedAt: new Date() }).where(eq(schema.places.id, placeId));
  }

  // --- Geofences (LOC-001/LOC-002) ----------------------------------------

  async listGeofences(userId: string) {
    return this.db.select().from(schema.geofences).where(eq(schema.geofences.ownerUserId, userId)).orderBy(desc(schema.geofences.createdAt));
  }

  async createGeofence(userId: string, dto: CreateGeofenceDto) {
    const place = await this.ownedOrHouseholdPlace(dto.placeId, userId);
    // A geofence needs real coordinates to register on-device — a place saved from a plain extracted
    // address (LOC-005, no geocoding provider configured) has none yet. Fail clearly rather than silently
    // registering an unusable region.
    if (place.lat == null || place.lng == null) {
      throw new BadRequestException({
        code: "PLACE_MISSING_COORDINATES",
        message: "This place has no coordinates yet — add a latitude/longitude before creating a geofence for it.",
      });
    }
    const id = generateId("geofence");
    await this.db.insert(schema.geofences).values({
      id,
      ownerUserId: userId,
      placeId: dto.placeId,
      radiusMeters: dto.radiusMeters,
      triggerKind: dto.triggerKind,
    });
    return { id };
  }

  private async ownedGeofence(geofenceId: string, userId: string) {
    const [geofence] = await this.db.select().from(schema.geofences).where(eq(schema.geofences.id, geofenceId)).limit(1);
    if (!geofence) throw new NotFoundException({ code: "GEOFENCE_NOT_FOUND", message: "Geofence not found." });
    if (geofence.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner can manage this geofence." });
    return geofence;
  }

  async updateGeofence(geofenceId: string, userId: string, dto: UpdateGeofenceDto) {
    await this.ownedGeofence(geofenceId, userId);
    await this.db
      .update(schema.geofences)
      .set({
        ...(dto.radiusMeters !== undefined ? { radiusMeters: dto.radiusMeters } : {}),
        ...(dto.triggerKind !== undefined ? { triggerKind: dto.triggerKind } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.nativeIdentifier !== undefined ? { nativeIdentifier: dto.nativeIdentifier } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.geofences.id, geofenceId));
    return { id: geofenceId };
  }

  async deleteGeofence(geofenceId: string, userId: string): Promise<void> {
    await this.ownedGeofence(geofenceId, userId);
    await this.db.delete(schema.geofences).where(eq(schema.geofences.id, geofenceId));
  }

  // --- Context rules (LOC-002/LOC-003) ------------------------------------

  async listContextRules(userId: string) {
    return this.db.select().from(schema.contextRules).where(eq(schema.contextRules.ownerUserId, userId)).orderBy(desc(schema.contextRules.createdAt));
  }

  async createContextRule(userId: string, dto: CreateContextRuleDto) {
    await this.ownedGeofence(dto.geofenceId, userId);
    const id = generateId("contextRule");
    await this.db.insert(schema.contextRules).values({
      id,
      ownerUserId: userId,
      geofenceId: dto.geofenceId,
      actionKind: dto.actionKind,
      actionTitle: dto.actionTitle,
      actionPayload: dto.actionPayload ?? {},
    });
    return { id };
  }

  private async ownedContextRule(contextRuleId: string, userId: string) {
    const [rule] = await this.db.select().from(schema.contextRules).where(eq(schema.contextRules.id, contextRuleId)).limit(1);
    if (!rule) throw new NotFoundException({ code: "CONTEXT_RULE_NOT_FOUND", message: "Reminder rule not found." });
    if (rule.ownerUserId !== userId) throw new ForbiddenException({ code: "NOT_OWNER", message: "Only the owner can manage this reminder." });
    return rule;
  }

  async updateContextRule(contextRuleId: string, userId: string, dto: UpdateContextRuleDto) {
    await this.ownedContextRule(contextRuleId, userId);
    await this.db
      .update(schema.contextRules)
      .set({
        ...(dto.actionTitle !== undefined ? { actionTitle: dto.actionTitle } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.contextRules.id, contextRuleId));
    return { id: contextRuleId };
  }

  async deleteContextRule(contextRuleId: string, userId: string): Promise<void> {
    await this.ownedContextRule(contextRuleId, userId);
    await this.db.delete(schema.contextRules).where(eq(schema.contextRules.id, contextRuleId));
  }

  // --- Geofence trigger events (LOC-002) ----------------------------------

  /**
   * Called by the mobile app's background geofence-event handler the moment the OS reports an
   * arrival/departure for a region it registered via `Location.startGeofencingAsync`. This is the ONLY
   * write path fed by an actual device signal in this whole module — and per this class's own doc
   * comment, it stores only which geofence fired, in which direction, and when. Firing an active
   * `context_rules` row for this geofence/direction files a plain `attention_items` row directly (rather
   * than routing through `AttentionService`, which has no public "file an arbitrary item" method today —
   * see its own doc comment on why its filing methods are scan-driven) so the reminder shows up in the
   * same Inbox/Attention surfaces every other obligation does.
   *
   * SAVE-004 "location-proximity" — on a real ARRIVAL specifically (regardless of what this geofence's own
   * `triggerKind` is configured to fire context_rules for — a location_proximity resurfacing rule is a
   * separate, saved-memory-scoped concern, not gated by this geofence's reminder-direction setting), this
   * also asks ResurfacingService to file a resurfacing for any saved memory linked to this place. See
   * ResurfacingService.fireLocationProximityResurfacing's own doc comment.
   */
  async recordGeofenceEvent(userId: string, dto: RecordGeofenceEventDto) {
    const geofence = await this.ownedGeofence(dto.geofenceId, userId);
    if (!geofence.isActive) {
      throw new BadRequestException({ code: "GEOFENCE_INACTIVE", message: "This geofence is turned off." });
    }
    // A geofence's own triggerKind ("arrival" | "departure" | "both") gates which direction it fires
    // rules for — "both" fires for either direction the OS reports, otherwise the reported direction must
    // match exactly.
    const directionMatches = geofence.triggerKind === "both" || geofence.triggerKind === dto.triggerKind;
    const activeRules = directionMatches
      ? await this.db
          .select()
          .from(schema.contextRules)
          .where(and(eq(schema.contextRules.geofenceId, dto.geofenceId), eq(schema.contextRules.isActive, true)))
      : [];
    for (const rule of activeRules) {
      await this.db.insert(schema.attentionItems).values({
        id: generateId("attentionItem"),
        ownerUserId: userId,
        reasonCode: "location_context_rule",
        reasonText: rule.actionTitle,
        urgency: "normal",
        confidenceBand: "verified",
        linkedResourceType: "context_rule",
        linkedResourceId: rule.id,
        primaryActions: ["view", "dismiss"],
      });
    }

    const resurfacingFired = dto.triggerKind === "arrival" ? await this.resurfacing.fireLocationProximityResurfacing(userId, geofence.placeId) : 0;

    const eventId = generateId("geofenceEvent");
    await this.db.insert(schema.geofenceEvents).values({
      id: eventId,
      ownerUserId: userId,
      geofenceId: dto.geofenceId,
      triggerKind: dto.triggerKind,
      contextRuleFired: activeRules.length > 0,
    });
    return { id: eventId, rulesFired: activeRules.length, resurfacingFired };
  }

  async listGeofenceEvents(userId: string, limit = 50) {
    return this.db
      .select()
      .from(schema.geofenceEvents)
      .where(eq(schema.geofenceEvents.ownerUserId, userId))
      .orderBy(desc(schema.geofenceEvents.occurredAt))
      .limit(limit);
  }

  // --- Location permission state (LOC-001 consent) ------------------------

  async getPermissionState(userId: string) {
    const [state] = await this.db.select().from(schema.locationPermissionState).where(eq(schema.locationPermissionState.userId, userId)).limit(1);
    return state ?? { userId, foregroundStatus: "undetermined", backgroundStatus: "undetermined", precision: "unknown", updatedAt: null };
  }

  async upsertPermissionState(userId: string, dto: UpsertLocationPermissionStateDto) {
    await this.db
      .insert(schema.locationPermissionState)
      .values({ userId, foregroundStatus: dto.foregroundStatus, backgroundStatus: dto.backgroundStatus, precision: dto.precision })
      .onConflictDoUpdate({
        target: schema.locationPermissionState.userId,
        set: { foregroundStatus: dto.foregroundStatus, backgroundStatus: dto.backgroundStatus, precision: dto.precision, updatedAt: new Date() },
      });
    return this.getPermissionState(userId);
  }

  // --- Travel-time estimate (LOC-004) -------------------------------------

  /**
   * See `packages/core/src/util/geo.ts`'s doc comment for why this is a haversine (straight-line)
   * estimate, not a real traffic-aware one: no maps/distance-matrix provider API key is configured in
   * this dev environment (`MAPS_PROVIDER_API_KEY` is unset — see docs/PHASE3_PENDING_CREDENTIALS.md).
   * `uncertaintyNote` is always returned alongside the number, never omitted.
   */
  async estimateTravelTime(userId: string, dto: EstimateTravelTimeDto) {
    const origin = await this.ownedOrHouseholdPlace(dto.originPlaceId, userId);
    const destination = await this.ownedOrHouseholdPlace(dto.destinationPlaceId, userId);
    if (origin.lat == null || origin.lng == null || destination.lat == null || destination.lng == null) {
      throw new BadRequestException({
        code: "PLACE_MISSING_COORDINATES",
        message: "Both places need coordinates before a travel-time estimate can be computed.",
      });
    }
    const estimate = estimateTravelTime({ lat: origin.lat, lng: origin.lng }, { lat: destination.lat, lng: destination.lng });
    const id = generateId("travelEstimate");
    await this.db.insert(schema.travelEstimates).values({
      id,
      ownerUserId: userId,
      originPlaceId: dto.originPlaceId,
      destinationPlaceId: dto.destinationPlaceId,
      distanceMeters: estimate.distanceMeters,
      estimatedMinutes: estimate.estimatedMinutes,
      method: estimate.method,
      uncertaintyNote: estimate.uncertaintyNote,
    });
    return { id, ...estimate };
  }
}
