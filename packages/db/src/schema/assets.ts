import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households, dependentProfiles } from "./household";
import { sensitivityTierEnum, visibilityEnum } from "./common";
import { encryptedText } from "./encrypted-type";
import { documents } from "./documents";

/**
 * Phase 2 §52.2 "Home/property and vehicle profiles; service/warranty/maintenance history." Deliberately
 * plain top-level tables (not a `canonical_entities` subtype) — a property/vehicle is a first-class object
 * a user directly creates and names, not something inferred from ingested evidence the way a purchase
 * line's asset entity is; giving it its own table keeps its own fields (address, VIN) strongly typed
 * instead of living in `facts.valueJson` untyped. Same visibility/sensitivity pattern as `documents`.
 */
export const propertyProfiles = pgTable(
  "property_profiles",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    label: encryptedText("label").notNull(), // e.g. "Home", "Lake cabin" — user-chosen, not derived
    propertyType: text("property_type").notNull().default("home"), // "home" | "rental" | "vacation" | "other"
    address: encryptedText("address"),
    moveInDate: jsonb("move_in_date").$type<TemporalValue>(),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("household"),
    // §40.1/40.2 "Property ... normalized full address + user property identity" / reversible merge —
    // mirrors people.mergedIntoPersonId exactly (plain text, no self-referencing FK — see that column's own
    // schema doc comment for why): a merged-away property row is excluded from normal list/detail queries
    // but never hard-deleted, so AssetsService.unmergeProperties can fully restore it later.
    mergedIntoPropertyId: text("merged_into_property_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("property_profiles_owner_idx").on(t.ownerUserId)],
);

/**
 * VEH-001 "VIN decode may prefill public vehicle attributes; user confirms." The subset of NHTSA vPIC's
 * `DecodeVinValues` response worth keeping around for display — deliberately NOT everything vPIC returns
 * (it has 100+ mostly-blank safety-equipment fields for an ordinary passenger car): just the handful a user
 * actually cares to see next to their vehicle. Lives in a single jsonb bucket rather than one column per
 * field, unlike `make`/`model`/`year` — those three are genuinely core fields other code already queries by
 * (recall matching, list display), while this is supplementary "what NHTSA told us" context with no query
 * need of its own. See VinDecodeService for how this gets populated.
 */
export interface VinDecodedAttributes {
  decodedFromVin: string; // the VIN actually sent to NHTSA — may differ from the vehicle's own `vin` column if a caller decoded an override
  trim: string | null;
  series: string | null;
  bodyClass: string | null;
  vehicleType: string | null;
  manufacturer: string | null;
  engineCylinders: number | null;
  engineHP: number | null;
  fuelTypePrimary: string | null;
  driveType: string | null;
  doors: number | null;
  plantCountry: string | null;
}

export const vehicleProfiles = pgTable(
  "vehicle_profiles",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    label: encryptedText("label").notNull(), // e.g. "Mom's Civic" — user-chosen, not derived
    make: text("make"),
    model: text("model"),
    year: integer("year"),
    vin: encryptedText("vin"),
    purchaseDate: jsonb("purchase_date").$type<TemporalValue>(),
    // VEH-001 VIN decode (NHTSA vPIC, free/no-key — same source family as RecallMonitorService's NHTSA
    // recall lookups). `vinDecodedAt` null means never decoded. Deliberately never overwrites `make`/
    // `model`/`year` once the user has set them — see VinDecodeService/AssetsService.applyVinDecode's own
    // doc comments: "user correction always outranks a guess" applies here exactly the way it does for
    // seeded merchant/jurisdiction data elsewhere in this codebase.
    vinDecodedAt: timestamp("vin_decoded_at", { withTimezone: true }),
    vinDecodeAttributes: jsonb("vin_decode_attributes").$type<VinDecodedAttributes>(),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("household"),
    // §40.1 "Vehicle ... VIN [is the] auto-merge standard" / §40.2 reversible merge — mirrors
    // people.mergedIntoPersonId exactly (see that column's own schema doc comment).
    mergedIntoVehicleId: text("merged_into_vehicle_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("vehicle_profiles_owner_idx").on(t.ownerUserId)],
);

/**
 * One row per service/maintenance event (oil change, HVAC service, roof repair, vet visit), linked to
 * whichever profile it belongs to — exactly one of `propertyProfileId`/`vehicleProfileId`/`petProfileId` is
 * set, enforced in application code (a DB CHECK constraint expressing "exactly one of N nullable FKs" needs
 * a raw SQL migration rather than Drizzle's table-builder API, not worth it for a Phase 2-stage table).
 * Evidence links via `sourceEventId` the same way every other domain row does (see `evidenceViaInboxItem` in
 * `commerce.service.ts`) rather than duplicating that pattern with a new column shape.
 *
 * PET-005 "insurance/service history" reuses this exact table for a pet's vet-visit/grooming service
 * history (`petProfileId` set) rather than inventing a parallel pet-specific history table — a vet visit is
 * structurally identical to an oil change or an HVAC service call (description + date + cost).
 */
export const maintenanceRecords = pgTable(
  "maintenance_records",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    propertyProfileId: text("property_profile_id").references(() => propertyProfiles.id, { onDelete: "cascade" }),
    vehicleProfileId: text("vehicle_profile_id").references(() => vehicleProfiles.id, { onDelete: "cascade" }),
    petProfileId: text("pet_profile_id").references(() => petProfiles.id, { onDelete: "cascade" }),
    description: encryptedText("description").notNull(),
    serviceDate: jsonb("service_date").$type<TemporalValue>(),
    serviceDateSort: timestamp("service_date_sort", { withTimezone: true }),
    costMinorUnits: integer("cost_minor_units"),
    costCurrency: text("cost_currency"),
    confidenceBand: text("confidence_band"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("maintenance_records_property_idx").on(t.propertyProfileId),
    index("maintenance_records_vehicle_idx").on(t.vehicleProfileId),
    index("maintenance_records_pet_idx").on(t.petProfileId),
  ],
);

/**
 * PET-001..PET-005 (spec ch.28 "Pets") — a household-owned Pet entity, structurally mirroring
 * `vehicleProfiles`/`propertyProfiles` above almost exactly (same owner/household/label/sensitivity/
 * visibility shape) rather than inventing a new pattern for what is, at the data-modeling level, the same
 * kind of thing: a first-class object a user directly creates and names.
 *
 * `photoDocumentId`/vaccination `documentId` (see `petVaccinations` below) reuse the Documents vault
 * (`documents`/`document_versions`) for file storage rather than building separate image/file storage — a
 * pet's photo or vaccination certificate is just a document, linked back to this row by FK.
 *
 * `lifecycleStatus` covers PET-001's "deceased pet archival, transferred ownership" edge states without a
 * hard delete (an archived/transferred pet's history — vaccinations, vet visits, insurance — should stay
 * queryable, same reasoning `deletedAt` gives every other soft-deletable row here).
 */
export const petProfiles = pgTable(
  "pet_profiles",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    label: encryptedText("label").notNull(), // pet's name — user-chosen, not derived
    // Plain/low-sensitivity per this feature's own design guidance — unlike `label`/`microchipNumber`,
    // knowing a household has "a dog named Rex" isn't identifying the way a microchip number is.
    species: text("species"),
    breed: text("breed"),
    birthDate: jsonb("birth_date").$type<TemporalValue>(), // birth OR adoption date — precision may be approximate/unknown
    // Genuinely identifying (a lost/stolen pet's chip number can be looked up to a specific owner) —
    // encrypted like vehicleProfiles.vin, the closest analog this schema already has.
    microchipNumber: encryptedText("microchip_number"),
    photoDocumentId: text("photo_document_id").references(() => documents.id, { onDelete: "set null" }),
    // §28 encryption-inventory sweep — sit in the same table as label/microchipNumber/insurancePolicyNumber
    // (all encryptedText above/below), and unlike species/breed just above (which carry an explicit
    // low-sensitivity justification comment), these two had no such justification — they reveal which vet
    // clinic/insurer a household uses. Only ever selected/assigned by row (emergency-binder.service.ts,
    // pets.service.ts), never filtered on, so encrypting is query-safe.
    vetProviderName: encryptedText("vet_provider_name"),
    insuranceProviderName: encryptedText("insurance_provider_name"),
    insurancePolicyNumber: encryptedText("insurance_policy_number"),
    lifecycleStatus: text("lifecycle_status").notNull().default("active"), // "active" | "deceased" | "transferred"
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("household"),
    // §40.2 reversible merge — pets have no VIN-equivalent unique identifier (see PetsService.
    // findPetMergeCandidates' own doc comment on the precision-first key used instead); mirrors
    // people.mergedIntoPersonId exactly regardless.
    mergedIntoPetId: text("merged_into_pet_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("pet_profiles_owner_idx").on(t.ownerUserId)],
);

/**
 * PET-004 "vaccination/license records" — one row per vaccine or license (rabies vaccination, city dog
 * license), linking the underlying certificate/license document (`documentId`, into the Documents vault —
 * see `petProfiles`' own doc comment) with a structured, scannable expiration date. `source` records
 * PET-004's own explicit requirement — "Deadline must be sourced/user-confirmed" — never AI-invented from
 * free text with no confirmation step; mirrors `warranties.confidenceBand`'s provenance tracking but adds
 * this narrower, spec-required distinction on top since a vaccination *deadline* (unlike a warranty
 * expiration) must never be filed purely on model confidence.
 *
 * `petProfileId` is nullable — a discovered vaccination email in a multi-pet household may not clearly
 * state which pet it's about (see `IngestionService.extractPetVaccination`'s conservative "don't guess"
 * matching, same discipline as `SchoolExtractionSchema`'s child-name matching). An unassigned row still
 * files as an inbox item; `householdId` lets it be found/assigned later even with no pet link yet.
 */
export const petVaccinations = pgTable(
  "pet_vaccinations",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    petProfileId: text("pet_profile_id").references(() => petProfiles.id, { onDelete: "cascade" }),
    label: encryptedText("label").notNull(), // e.g. "Rabies", "City dog license"
    documentId: text("document_id").references(() => documents.id, { onDelete: "set null" }),
    expirationDate: jsonb("expiration_date").$type<TemporalValue>(),
    expirationDateSort: timestamp("expiration_date_sort", { withTimezone: true }),
    // "evidence_sourced" (extracted from an email/document, still surfaced for confirmation via the normal
    // inbox-item confirm/correct/dismiss flow) | "user_confirmed" (typed in directly, or confirmed from an
    // inbox item) — never filed as a scannable deadline before one of these is true; see
    // AttentionService.scanAndFileDeadlines's pet-vaccination scan.
    source: text("source").notNull().default("user_confirmed"),
    confidenceBand: text("confidence_band"),
    sourceEventId: text("source_event_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pet_vaccinations_pet_idx").on(t.petProfileId), index("pet_vaccinations_expiration_idx").on(t.expirationDateSort)],
);

/**
 * PET-003 "medication/refill logistics" — user-configured reminders for refills/administration schedule,
 * deliberately logistics-only per spec: "No veterinary diagnosis/dosing inference from free text." Just a
 * plain user-entered medication name, a next refill/pickup date, and an optional pharmacy — no dose,
 * frequency, or other clinical field that would imply Veynlo is inferring anything medical.
 *
 * Deliberately named generically (`refill_reminders`, not `pet_refill_reminders`) and scoped via a
 * *nullable* `petProfileId` rather than a required one: at the time this table was built there was no
 * Health Logistics module/table yet for the equivalent human-family-member medication refill reminders
 * (checked — no `refillReminders`/`refill_reminders` anywhere in the codebase). Building a second, separate
 * `pet_refill_reminders` table now would leave two structurally identical reminder tables once that
 * human-scoped feature ships. Instead: this table already has the right shape for both, and a future
 * Health Logistics build-out should extend THIS table with its own nullable person-scoping column (e.g.
 * `dependentProfileId`) alongside `petProfileId`, rather than standing up a parallel system. Don't be
 * confused by the pet-only rows here today — the table itself isn't pet-specific, only its current data is.
 */
export const refillReminders = pgTable(
  "refill_reminders",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    petProfileId: text("pet_profile_id").references(() => petProfiles.id, { onDelete: "cascade" }),
    // §27 "Health Logistics" (HLTH-003) — the nullable "person-scoping" column this table's own doc comment
    // above anticipated ("a future Health Logistics build-out should extend THIS table with its own
    // nullable person-scoping column ... rather than standing up a parallel system"). Null means either a
    // pet row (petProfileId set instead) or the account owner's own reminder; set only when the reminder is
    // for a specific dependent household member. `HealthLogisticsService` scopes its own reads to
    // `petProfileId IS NULL` (the human/health side of this shared table).
    dependentProfileId: text("dependent_profile_id").references(() => dependentProfiles.id, { onDelete: "cascade" }),
    medicationName: encryptedText("medication_name").notNull(),
    nextRefillDate: jsonb("next_refill_date").$type<TemporalValue>().notNull(),
    nextRefillDateSort: timestamp("next_refill_date_sort", { withTimezone: true }),
    pharmacy: text("pharmacy"),
    notes: encryptedText("notes"),
    // HLTH-003 "mark picked up" user action — set once the refill has actually been collected, so
    // AttentionService's deadline scan can stop surfacing a reminder the user already acted on (mirrors
    // bills.paymentObservedTransactionId's "distinguish due from already-handled" role).
    pickedUpAt: timestamp("picked_up_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("refill_reminders_pet_idx").on(t.petProfileId),
    index("refill_reminders_next_date_idx").on(t.nextRefillDateSort),
  ],
);

/**
 * VEH-001 "Odometer observations are timestamped with source/confidence; schedule calculates whichever
 * interval is first" / VEH-007. Previously nothing tracked a vehicle's mileage at all (TASK-003's
 * recurrence engine explicitly deferred "every 5,000 miles" recurrence for exactly this reason — see
 * `packages/core/src/util/recurrence.ts`'s own doc comment). One row per reading rather than a single
 * `currentMileage` column on `vehicleProfiles`: the spec's own "odometer rollback/data error" edge case
 * means a later-timestamped reading isn't automatically more trustworthy than an earlier one (a bad manual
 * entry, or a service record with a lower mileage than a fresher direct entry), so keeping full history
 * lets `latestOdometerMileage`-style lookups reason about it (e.g. prefer the highest-confidence recent
 * reading) rather than just trusting whichever was inserted last.
 */
export const odometerObservations = pgTable(
  "odometer_observations",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vehicleProfileId: text("vehicle_profile_id")
      .notNull()
      .references(() => vehicleProfiles.id, { onDelete: "cascade" }),
    mileage: integer("mileage").notNull(),
    observedAt: jsonb("observed_at").$type<TemporalValue>().notNull(),
    observedAtSort: timestamp("observed_at_sort", { withTimezone: true }),
    // "user_entered" (typed directly into the odometer field) | "service_record" (carried over from a
    // maintenance_records row's own mileage, once that flow captures one — see AssetsService's own doc
    // comment on why service records don't yet capture mileage directly).
    source: text("source").notNull().default("user_entered"),
    confidenceBand: text("confidence_band").notNull().default("verified"), // user-entered directly, same reasoning as maintenanceRecords.confidenceBand
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("odometer_observations_vehicle_idx").on(t.vehicleProfileId, t.observedAtSort)],
);

/**
 * VEH-007 "Track tire brand/model/size, install date/mileage, rotation, pressure spec source, road-hazard
 * warranty and replacement." `rotationHistory` is a plain jsonb array of `{date, mileage}` entries rather
 * than its own table — a rotation is a lightweight logged event with no further structure of its own (no
 * cost/vendor/documents the way a `maintenanceRecords` row has), so a separate table would just be an
 * unindexed list by another name; nothing here ever needs to query "all rotations across every tire" on
 * its own, only "this tire's own history," which jsonb already serves directly off this row.
 */
export const tires = pgTable(
  "tires",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vehicleProfileId: text("vehicle_profile_id")
      .notNull()
      .references(() => vehicleProfiles.id, { onDelete: "cascade" }),
    brand: text("brand"),
    model: text("model"),
    size: text("size"), // e.g. "225/45R17"
    installDate: jsonb("install_date").$type<TemporalValue>(),
    installMileage: integer("install_mileage"),
    rotationHistory: jsonb("rotation_history").$type<Array<{ date: string; mileage: number | null }>>().notNull().default([]),
    pressureSpecPsi: integer("pressure_spec_psi"),
    warrantyMonths: integer("warranty_months"),
    roadHazardWarranty: text("road_hazard_warranty"), // free-text summary (provider/terms) — not a structured warranties row since it's tire-specific coverage, not a product warranty
    status: text("status").notNull().default("active"), // "active" | "replaced"
    replacedAt: jsonb("replaced_at").$type<TemporalValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("tires_vehicle_idx").on(t.vehicleProfileId)],
);

/**
 * HOMEOS-008 "Home systems/appliances aren't currently modeled as discrete tracked assets with
 * make/model/serial" gap-close — mirrors `vehicleProfiles`'s shape (same owner/label/sensitivity pattern)
 * but scoped to a `propertyProfileId` rather than being a top-level profile of its own: a home asset (a
 * water heater, a refrigerator) only exists in the context of a property, unlike a vehicle or property
 * itself, which are independent first-class objects a user names directly.
 */
export const homeAssets = pgTable(
  "home_assets",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    propertyProfileId: text("property_profile_id")
      .notNull()
      .references(() => propertyProfiles.id, { onDelete: "cascade" }),
    label: encryptedText("label").notNull(), // e.g. "Kitchen refrigerator", "Basement water heater"
    category: text("category"), // "appliance" | "hvac" | "plumbing" | "electrical" | "other" — free-form guidance, not enforced
    // HOMEOS-002 "Organize assets spatially... User can add rooms as needed... must be editable" / "without
    // forcing setup." A plain free-text label ("Kitchen", "Garage", "Primary bedroom") rather than a
    // normalized `rooms`/`areas` table with its own required create-first step: the spec's own wording is
    // explicit that room assignment must never force setup, and nothing else in this codebase today needs
    // to query "all assets in room X across properties" or attach photos/dimensions to a room as its own
    // entity — a search/filter by this column already serves HOMEOS-007's "searchable by room." If a future
    // feature needs a room as a first-class object (its own photos, dimensions, maintenance context per
    // 22.1's hierarchy table), promoting this to a real `property_areas` table is a straightforward
    // follow-up; nothing here forecloses it.
    room: text("room"),
    make: text("make"),
    model: text("model"),
    serial: encryptedText("serial"), // genuinely identifying, like vehicleProfiles.vin — encrypted
    installDate: jsonb("install_date").$type<TemporalValue>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("home_assets_property_idx").on(t.propertyProfileId)],
);

/**
 * VEH-006 "Match VIN/model/year to authoritative recall data... Alerts distinguish open, repaired/closed if
 * known, and 'potential match; verify VIN.'" / HOMEOS-008 "Recall matching uses model/serial scope when
 * available; never alert solely on loose brand similarity." One shared table for both vehicle (NHTSA) and
 * home-asset (CPSC) recall subjects — exactly one of `vehicleProfileId`/`homeAssetId` is set, same
 * "exactly one of N nullable FKs enforced in application code" pattern as `maintenanceRecords` above.
 *
 * `status` is never inferred beyond what the source API actually confirms: NHTSA's by-vehicle endpoint
 * matches on make+model+modelYear, not a specific VIN, so a NHTSA match always starts at
 * "potential_match_verify_vin" (see RecallMonitorService) rather than being asserted as definitely
 * affecting this exact vehicle — the spec's own explicit "never alert solely on loose brand similarity"
 * bar, applied one level stricter: even an exact make/model/year match still isn't a VIN-confirmed match.
 * "closed_or_repaired" is set only from a user's own action (marking it handled), never inferred from the
 * source data — NHTSA/CPSC recall feeds don't report per-vehicle repair completion.
 */
export const recallMatches = pgTable(
  "recall_matches",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vehicleProfileId: text("vehicle_profile_id").references(() => vehicleProfiles.id, { onDelete: "cascade" }),
    homeAssetId: text("home_asset_id").references(() => homeAssets.id, { onDelete: "cascade" }),
    source: text("source").notNull(), // "nhtsa" | "cpsc"
    campaignNumber: text("campaign_number").notNull(), // NHTSACampaignNumber, or CPSC RecallNumber
    component: text("component"), // NHTSA "Component", or a CPSC hazard/product-type summary
    summary: text("summary").notNull(), // public recall text from the source agency — not user data, not encrypted
    remedy: text("remedy"),
    url: text("url"),
    // Recorded verbatim from the source's own response, alongside the vehicle/home-asset's stored
    // make/model — lets the UI show exactly what was matched against, per VEH-006's "never alert solely on
    // loose brand similarity" transparency bar.
    matchedMake: text("matched_make"),
    matchedModel: text("matched_model"),
    matchedYear: integer("matched_year"),
    status: text("status").notNull().default("potential_match_verify_vin"), // "open" | "potential_match_verify_vin" | "closed_or_repaired"
    reportedDate: jsonb("reported_date").$type<TemporalValue>(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("recall_matches_vehicle_idx").on(t.vehicleProfileId),
    index("recall_matches_home_asset_idx").on(t.homeAssetId),
    // Lookup key RecallMonitorService uses to avoid inserting a duplicate row for the same
    // subject+source+campaign on a re-scan — application-level "select then insert/update" (same style as
    // AttentionService.fileIfNew), not a DB-level unique constraint, since "subject" is one of two nullable
    // columns and a single composite unique index can't express "unique per whichever of these two is set."
    index("recall_matches_campaign_idx").on(t.source, t.campaignNumber),
  ],
);

/**
 * HOMEOS-004/VEH-003 "Maintenance engine" / "Maintenance schedule" — a forward-looking recurring
 * obligation ("oil change due every 5,000 mi or 6 months, whichever first," "HVAC filter every 90 days"),
 * distinct from `maintenanceRecords` above which only ever logs a PAST service event. Exactly one of
 * `vehicleProfileId`/`homeAssetId` is set, same "enforced in application code" pattern as
 * `maintenanceRecords`/`recallMatches`.
 *
 * `intervalType` picks which of `intervalDays`/`intervalMiles` apply:
 *  - "calendar": `intervalDays` only (home assets — HVAC filters, smoke detectors — are always this kind,
 *    since a home asset has no odometer).
 *  - "mileage": `intervalMiles` only, evaluated against the vehicle's current odometer reading (see
 *    AttentionService's own scan — the same `odometer_observations` "highest reading wins" reasoning
 *    `AssetsService.latestOdometerMileage` already documents applies here too).
 *  - "calendar_or_mileage": both set, due at whichever comes first — VEH-003's own "mileage/time rules
 *    coexist" and the odometer schema's "schedule calculates whichever interval is first" requirement.
 *
 * `lastPerformedDate`/`lastPerformedDateSort` is the calendar anchor a due date counts forward from (null
 * defaults to `createdAt` — a rule with nothing logged yet is treated as "due one interval after it was
 * set up"); `baselineMileage` is the mileage anchor (null defaults to the vehicle's earliest known odometer
 * reading). Both re-anchor via the "mark done" action (`AssetsService.completeMaintenanceRule`) rather than
 * being recomputed from `maintenanceRecords` automatically — there's no reliable way to tell which logged
 * service event, if any, corresponds to which rule (a user might log "Oil change" text that doesn't match
 * any rule's `label` exactly), so this stays an explicit, cheap user action instead of fragile text matching.
 *
 * `source`/`confidenceNote` distinguish a rule the user typed in themselves from one added via a seeded
 * generic-guidance template (see `maintenance-rule-templates.ts`) — VEH-003's own "manufacturer schedule
 * only presented as sourced guidance" bar, applied one level more conservatively: this app never claims to
 * know any specific manufacturer's actual schedule at all, only genuinely well-known generic industry
 * guidance (e.g. "5,000–7,500 mi or 6 months" for an oil change), always labeled as such via
 * `confidenceNote` and surfaced at `confidenceBand: "approximate"` in the attention scan rather than
 * "verified." A user can add/edit/delete any rule regardless of its source — editing one clears back to
 * `source: "user_added"` (see AssetsService.updateMaintenanceRule's own doc comment): once a user has
 * touched the numbers, it's their rule, not a guess anymore.
 */
export const maintenanceRules = pgTable(
  "maintenance_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vehicleProfileId: text("vehicle_profile_id").references(() => vehicleProfiles.id, { onDelete: "cascade" }),
    homeAssetId: text("home_asset_id").references(() => homeAssets.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // e.g. "Oil change", "HVAC filter" — a maintenance task name, not sensitive on its own
    intervalType: text("interval_type").notNull(), // "calendar" | "mileage" | "calendar_or_mileage"
    intervalDays: integer("interval_days"),
    intervalMiles: integer("interval_miles"),
    baselineMileage: integer("baseline_mileage"),
    lastPerformedDate: jsonb("last_performed_date").$type<TemporalValue>(),
    lastPerformedDateSort: timestamp("last_performed_date_sort", { withTimezone: true }),
    source: text("source").notNull().default("user_added"), // "user_added" | "seeded_generic_guidance"
    confidenceNote: text("confidence_note"), // set only for "seeded_generic_guidance" rows — the honest "this is general guidance, not your manufacturer's schedule" disclosure shown alongside the rule
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("maintenance_rules_vehicle_idx").on(t.vehicleProfileId), index("maintenance_rules_home_asset_idx").on(t.homeAssetId)],
);

/**
 * VEH-004 "Registration / inspection / emissions" — "Create jurisdiction-backed or user-provided
 * deadlines." Always user-entered (no free/public API gives a per-vehicle registration/inspection due date
 * the way NHTSA gives recalls — a state DMV's renewal date is account-specific, not public data), same
 * "never infer a legal-compliance deadline without authoritative evidence" discipline ID-005's identical
 * wording states for property/government obligations.
 *
 * `status`/`reminderLeadDays` mirror `identityRecords`' own expiration lifecycle (see
 * AttentionService.scanAndFileDeadlines' identity-records scan) rather than inventing a new shape: "active"
 * until the due date passes (auto-flipped to "expired" by the scan, never by this table's own writers), and
 * a per-row configurable lead time since a registration renewal's sensible notice window varies more than a
 * bill's fixed few days. "renew" (`AssetsService.renewRegistrationRecord`) is the only path back to
 * "active" — VEH-004's "renewal ... completion rolls forward based on new evidence or user confirmation"
 * means this only ever advances on an explicit user action with a real new due date, never guessed.
 */
export const registrationRecords = pgTable(
  "registration_records",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vehicleProfileId: text("vehicle_profile_id")
      .notNull()
      .references(() => vehicleProfiles.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull().default("registration"), // "registration" | "inspection" | "emissions" | "other"
    jurisdiction: text("jurisdiction"), // e.g. a US state — plain text, not sensitive on its own (unlike vin/label elsewhere)
    renewalDueDate: jsonb("renewal_due_date").$type<TemporalValue>(),
    renewalDueDateSort: timestamp("renewal_due_date_sort", { withTimezone: true }),
    reminderLeadDays: integer("reminder_lead_days").notNull().default(30),
    lastRenewedDate: jsonb("last_renewed_date").$type<TemporalValue>(),
    notes: encryptedText("notes"),
    status: text("status").notNull().default("active"), // "active" | "expired" — mirrors identityRecords.status
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("registration_records_vehicle_idx").on(t.vehicleProfileId), index("registration_records_due_idx").on(t.renewalDueDateSort)],
);

/**
 * §40.1/40.2 "Vehicle ... VIN [is the] auto-merge standard" / "Merge, unmerge and identity history" —
 * reversible-merge lineage for vehicles, mirroring `personMergeLineage` (people.ts) field-for-field, adapted
 * to this domain's six satellite tables (maintenanceRecords/odometerObservations/tires/recallMatches/
 * maintenanceRules/registrationRecords) instead of people's five, plus `warranties` — found missing during
 * this pass the same way AdminService.mergeMerchants' own doc comment describes finding storeCredits/
 * recurringStreams missing from an earlier merchant-merge pass: a vehicle-scoped warranty carries the same
 * `vehicleProfileId` FK every other vehicle satellite table does, and leaving it unrepointed would silently
 * orphan it onto a merged-away vehicle excluded from every list/detail query. See
 * AssetsService.mergeVehicles' own doc comment for the shared design this mirrors.
 */
export const vehicleMergeLineage = pgTable(
  "vehicle_merge_lineage",
  {
    id: text("id").primaryKey(),
    survivingVehicleId: text("surviving_vehicle_id")
      .notNull()
      .references(() => vehicleProfiles.id),
    mergedVehicleId: text("merged_vehicle_id")
      .notNull()
      .references(() => vehicleProfiles.id),
    mergedVehicleSnapshot: jsonb("merged_vehicle_snapshot").$type<Record<string, unknown>>().notNull(),
    repointedMaintenanceRecordIds: jsonb("repointed_maintenance_record_ids").$type<string[]>().notNull().default([]),
    repointedOdometerObservationIds: jsonb("repointed_odometer_observation_ids").$type<string[]>().notNull().default([]),
    repointedTireIds: jsonb("repointed_tire_ids").$type<string[]>().notNull().default([]),
    repointedRecallMatchIds: jsonb("repointed_recall_match_ids").$type<string[]>().notNull().default([]),
    repointedMaintenanceRuleIds: jsonb("repointed_maintenance_rule_ids").$type<string[]>().notNull().default([]),
    repointedRegistrationRecordIds: jsonb("repointed_registration_record_ids").$type<string[]>().notNull().default([]),
    repointedWarrantyIds: jsonb("repointed_warranty_ids").$type<string[]>().notNull().default([]),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
  },
  (t) => [index("vehicle_merge_lineage_surviving_idx").on(t.survivingVehicleId)],
);

/**
 * §40.1/40.2 "Property ... normalized full address + user property identity" / "Merge, unmerge and identity
 * history" — reversible-merge lineage for properties, mirroring `personMergeLineage`, adapted to this
 * domain's two satellite tables (maintenanceRecords/homeAssets) plus `warranties` (same "found missing"
 * reasoning as `vehicleMergeLineage`'s own doc comment above). A home asset's OWN child rows
 * (recallMatches.homeAssetId, maintenanceRules.homeAssetId) never need a separate repoint here: they follow
 * their parent home-asset row automatically once `homeAssets.propertyProfileId` is repointed onto the
 * survivor — see AssetsService.mergeProperties' own doc comment.
 */
export const propertyMergeLineage = pgTable(
  "property_merge_lineage",
  {
    id: text("id").primaryKey(),
    survivingPropertyId: text("surviving_property_id")
      .notNull()
      .references(() => propertyProfiles.id),
    mergedPropertyId: text("merged_property_id")
      .notNull()
      .references(() => propertyProfiles.id),
    mergedPropertySnapshot: jsonb("merged_property_snapshot").$type<Record<string, unknown>>().notNull(),
    repointedMaintenanceRecordIds: jsonb("repointed_maintenance_record_ids").$type<string[]>().notNull().default([]),
    repointedHomeAssetIds: jsonb("repointed_home_asset_ids").$type<string[]>().notNull().default([]),
    repointedWarrantyIds: jsonb("repointed_warranty_ids").$type<string[]>().notNull().default([]),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
  },
  (t) => [index("property_merge_lineage_surviving_idx").on(t.survivingPropertyId)],
);

/**
 * §40.2 "Merge, unmerge and identity history" — reversible-merge lineage for pets, mirroring
 * `personMergeLineage`, adapted to this domain's four satellite tables (petVaccinations/refillReminders/
 * maintenanceRecords/bills). See PetsService.mergePets' own doc comment for the precision-first merge key
 * used (pets have no VIN-equivalent unique identifier) and for how on-profile fields (vet/insurance info)
 * are combined onto the survivor.
 */
export const petMergeLineage = pgTable(
  "pet_merge_lineage",
  {
    id: text("id").primaryKey(),
    survivingPetId: text("surviving_pet_id")
      .notNull()
      .references(() => petProfiles.id),
    mergedPetId: text("merged_pet_id")
      .notNull()
      .references(() => petProfiles.id),
    mergedPetSnapshot: jsonb("merged_pet_snapshot").$type<Record<string, unknown>>().notNull(),
    repointedVaccinationIds: jsonb("repointed_vaccination_ids").$type<string[]>().notNull().default([]),
    repointedRefillReminderIds: jsonb("repointed_refill_reminder_ids").$type<string[]>().notNull().default([]),
    repointedMaintenanceRecordIds: jsonb("repointed_maintenance_record_ids").$type<string[]>().notNull().default([]),
    repointedBillIds: jsonb("repointed_bill_ids").$type<string[]>().notNull().default([]),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
  },
  (t) => [index("pet_merge_lineage_surviving_idx").on(t.survivingPetId)],
);
