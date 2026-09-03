import { z } from "zod";

export const CreatePropertyProfileDtoSchema = z.object({
  label: z.string().min(1).max(120),
  propertyType: z.enum(["home", "rental", "vacation", "other"]).default("home"),
  address: z.string().max(500).nullable().optional(),
  moveInDateIso: z.string().nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreatePropertyProfileDto = z.infer<typeof CreatePropertyProfileDtoSchema>;

export const CreateVehicleProfileDtoSchema = z.object({
  label: z.string().min(1).max(120),
  make: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  year: z.number().int().min(1900).max(2100).nullable().optional(),
  vin: z.string().max(32).nullable().optional(),
  purchaseDateIso: z.string().nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreateVehicleProfileDto = z.infer<typeof CreateVehicleProfileDtoSchema>;

/**
 * Found live: a property/vehicle profile had no edit endpoint at all (only create/delete) — so
 * `householdId`, even though the create DTO already accepted it, could never be assigned/changed after
 * the fact. Confirmed live: a vehicle/property added before its owner joined a household (or added while
 * "private" by choice) had no way to ever show up in that household's Emergency Binder, since
 * EmergencyBinderService.getBinder queries `vehicleProfiles`/`propertyProfiles` by `householdId` alone.
 * Every field optional (a PATCH-style partial update), mirroring UpdateHomeAssetDtoSchema's own shape.
 * `householdId: null` explicitly means "make this private again" — distinct from omitting the field
 * entirely (which leaves the existing household association untouched).
 */
export const UpdatePropertyProfileDtoSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  propertyType: z.enum(["home", "rental", "vacation", "other"]).optional(),
  address: z.string().max(500).nullable().optional(),
  moveInDateIso: z.string().nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type UpdatePropertyProfileDto = z.infer<typeof UpdatePropertyProfileDtoSchema>;

/** See UpdatePropertyProfileDtoSchema's own doc comment — the vehicle-profile counterpart of the same gap. */
export const UpdateVehicleProfileDtoSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  make: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  year: z.number().int().min(1900).max(2100).nullable().optional(),
  vin: z.string().max(32).nullable().optional(),
  purchaseDateIso: z.string().nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type UpdateVehicleProfileDto = z.infer<typeof UpdateVehicleProfileDtoSchema>;

export const CreateMaintenanceRecordDtoSchema = z
  .object({
    description: z.string().min(1).max(500),
    serviceDateIso: z.string().nullable().optional(),
    costMinorUnits: z.number().int().nonnegative().nullable().optional(),
    costCurrency: z.string().length(3).nullable().optional(),
    propertyProfileId: z.string().nullable().optional(),
    vehicleProfileId: z.string().nullable().optional(),
    // PET-005 "insurance/service history" — a vet visit/grooming appointment reuses this same table
    // (see maintenanceRecords' own schema doc comment) rather than a parallel pet-history table.
    petProfileId: z.string().nullable().optional(),
  })
  .refine((dto) => [dto.propertyProfileId, dto.vehicleProfileId, dto.petProfileId].filter(Boolean).length === 1, {
    message: "Exactly one of propertyProfileId, vehicleProfileId, or petProfileId must be set.",
  });
export type CreateMaintenanceRecordDto = z.infer<typeof CreateMaintenanceRecordDtoSchema>;

// VEH-001/VEH-007 — odometer_observations. `observedAtIso` defaults to "now" in the service when omitted
// (a manual odometer entry is almost always "what does it read right now"), never inferred from anything
// else.
export const CreateOdometerObservationDtoSchema = z.object({
  vehicleProfileId: z.string(),
  mileage: z.number().int().min(0).max(2_000_000),
  observedAtIso: z.string().nullable().optional(),
  source: z.enum(["user_entered", "service_record"]).default("user_entered"),
});
export type CreateOdometerObservationDto = z.infer<typeof CreateOdometerObservationDtoSchema>;

// VEH-007 — tires.
export const CreateTireDtoSchema = z.object({
  vehicleProfileId: z.string(),
  brand: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  size: z.string().max(30).nullable().optional(),
  installDateIso: z.string().nullable().optional(),
  installMileage: z.number().int().min(0).max(2_000_000).nullable().optional(),
  pressureSpecPsi: z.number().int().min(1).max(200).nullable().optional(),
  warrantyMonths: z.number().int().min(0).max(600).nullable().optional(),
  roadHazardWarranty: z.string().max(300).nullable().optional(),
});
export type CreateTireDto = z.infer<typeof CreateTireDtoSchema>;

export const RecordTireRotationDtoSchema = z.object({
  dateIso: z.string().nullable().optional(),
  mileage: z.number().int().min(0).max(2_000_000).nullable().optional(),
});
export type RecordTireRotationDto = z.infer<typeof RecordTireRotationDtoSchema>;

export const ReplaceTireDtoSchema = z.object({
  replacedAtIso: z.string().nullable().optional(),
});
export type ReplaceTireDto = z.infer<typeof ReplaceTireDtoSchema>;

// HOMEOS-008 — home_assets. propertyProfileId is required (unlike propertyProfiles/vehicleProfiles, a home
// asset only ever exists in the context of a property — see assets.ts's own schema doc comment).
export const CreateHomeAssetDtoSchema = z.object({
  propertyProfileId: z.string(),
  label: z.string().min(1).max(120),
  category: z.enum(["appliance", "hvac", "plumbing", "electrical", "other"]).nullable().optional(),
  // HOMEOS-002 "Add rooms as needed... must be editable" — free-text so a user can type "Kitchen"/"Garage"
  // without first creating any kind of room object. See homeAssets.room's own schema doc comment.
  room: z.string().max(80).nullable().optional(),
  make: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  serial: z.string().max(120).nullable().optional(),
  installDateIso: z.string().nullable().optional(),
});
export type CreateHomeAssetDto = z.infer<typeof CreateHomeAssetDtoSchema>;

// VEH-001 — VIN decode (NHTSA vPIC, free/no-key). `vin` intentionally has the same bounds as
// CreateVehicleProfileDtoSchema.vin above.
export const DecodeVinDtoSchema = z.object({ vin: z.string().min(5).max(32) });
export type DecodeVinDto = z.infer<typeof DecodeVinDtoSchema>;

// HOMEOS-002 — room/area label on a home asset. A separate schema (rather than folding into
// CreateHomeAssetDtoSchema) so PATCH-style edit endpoints can reuse it without needing every other field.
export const UpdateHomeAssetDtoSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  category: z.enum(["appliance", "hvac", "plumbing", "electrical", "other"]).nullable().optional(),
  room: z.string().max(80).nullable().optional(),
  make: z.string().max(60).nullable().optional(),
  model: z.string().max(60).nullable().optional(),
  serial: z.string().max(120).nullable().optional(),
  installDateIso: z.string().nullable().optional(),
});
export type UpdateHomeAssetDto = z.infer<typeof UpdateHomeAssetDtoSchema>;

// HOMEOS-004/VEH-003 — maintenance_rules. Exactly one of vehicleProfileId/homeAssetId, mirroring
// CreateMaintenanceRecordDtoSchema's own refine. A home asset has no odometer, so it can only ever use a
// "calendar" rule — enforced here rather than left to the service layer, same "reject-at-the-boundary"
// discipline every other DTO in this file already follows.
export const CreateMaintenanceRuleDtoSchema = z
  .object({
    vehicleProfileId: z.string().nullable().optional(),
    homeAssetId: z.string().nullable().optional(),
    label: z.string().min(1).max(120),
    intervalType: z.enum(["calendar", "mileage", "calendar_or_mileage"]),
    intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
    intervalMiles: z.number().int().min(1).max(200_000).nullable().optional(),
    baselineMileage: z.number().int().min(0).max(2_000_000).nullable().optional(),
    lastPerformedDateIso: z.string().nullable().optional(),
  })
  .refine((dto) => [dto.vehicleProfileId, dto.homeAssetId].filter(Boolean).length === 1, {
    message: "Exactly one of vehicleProfileId or homeAssetId must be set.",
  })
  .refine((dto) => !dto.homeAssetId || dto.intervalType === "calendar", {
    message: "A home asset has no odometer — its maintenance rules can only be calendar-based.",
  })
  .refine((dto) => (dto.intervalType === "calendar" || dto.intervalType === "calendar_or_mileage" ? dto.intervalDays != null : true), {
    message: "intervalDays is required for a calendar or calendar_or_mileage rule.",
  })
  .refine((dto) => (dto.intervalType === "mileage" || dto.intervalType === "calendar_or_mileage" ? dto.intervalMiles != null : true), {
    message: "intervalMiles is required for a mileage or calendar_or_mileage rule.",
  });
export type CreateMaintenanceRuleDto = z.infer<typeof CreateMaintenanceRuleDtoSchema>;

export const UpdateMaintenanceRuleDtoSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  intervalType: z.enum(["calendar", "mileage", "calendar_or_mileage"]).optional(),
  intervalDays: z.number().int().min(1).max(3650).nullable().optional(),
  intervalMiles: z.number().int().min(1).max(200_000).nullable().optional(),
  baselineMileage: z.number().int().min(0).max(2_000_000).nullable().optional(),
});
export type UpdateMaintenanceRuleDto = z.infer<typeof UpdateMaintenanceRuleDtoSchema>;

// "Mark done" — rolls a rule's calendar/mileage anchor forward. See
// AssetsService.completeMaintenanceRule's own doc comment for how an omitted performedMileage re-anchors.
export const CompleteMaintenanceRuleDtoSchema = z.object({
  performedDateIso: z.string().nullable().optional(),
  performedMileage: z.number().int().min(0).max(2_000_000).nullable().optional(),
});
export type CompleteMaintenanceRuleDto = z.infer<typeof CompleteMaintenanceRuleDtoSchema>;

export const CreateMaintenanceRuleFromTemplateDtoSchema = z
  .object({
    vehicleProfileId: z.string().nullable().optional(),
    homeAssetId: z.string().nullable().optional(),
    templateKey: z.string().min(1).max(60),
  })
  .refine((dto) => [dto.vehicleProfileId, dto.homeAssetId].filter(Boolean).length === 1, {
    message: "Exactly one of vehicleProfileId or homeAssetId must be set.",
  });
export type CreateMaintenanceRuleFromTemplateDto = z.infer<typeof CreateMaintenanceRuleFromTemplateDtoSchema>;

// VEH-004 — registration_records. Always user-entered (see the table's own schema doc comment on why no
// public API can supply this).
export const CreateRegistrationRecordDtoSchema = z.object({
  vehicleProfileId: z.string(),
  recordType: z.enum(["registration", "inspection", "emissions", "other"]).default("registration"),
  jurisdiction: z.string().max(80).nullable().optional(),
  renewalDueDateIso: z.string().nullable().optional(),
  reminderLeadDays: z.number().int().min(1).max(365).default(30),
  notes: z.string().max(1000).nullable().optional(),
});
export type CreateRegistrationRecordDto = z.infer<typeof CreateRegistrationRecordDtoSchema>;

export const UpdateRegistrationRecordDtoSchema = z.object({
  recordType: z.enum(["registration", "inspection", "emissions", "other"]).optional(),
  jurisdiction: z.string().max(80).nullable().optional(),
  renewalDueDateIso: z.string().nullable().optional(),
  reminderLeadDays: z.number().int().min(1).max(365).optional(),
  notes: z.string().max(1000).nullable().optional(),
});
export type UpdateRegistrationRecordDto = z.infer<typeof UpdateRegistrationRecordDtoSchema>;

// "Renew" — VEH-004 "Renewal/inspection completion rolls forward based on new evidence or user
// confirmation." `newDueDateIso` is required rather than optional: the whole point of this action is
// advancing to the next real deadline, never guessed — a user who doesn't yet know the next due date should
// simply leave the record as-is rather than "renew" it into a fresh, unfounded date.
export const RenewRegistrationRecordDtoSchema = z.object({
  renewedDateIso: z.string().nullable().optional(),
  newDueDateIso: z.string(),
});
export type RenewRegistrationRecordDto = z.infer<typeof RenewRegistrationRecordDtoSchema>;

// §40.1/40.2 "Entity Resolution" gap-close — reversible merge for vehicles/properties, mirroring
// people/dto.ts's MergePeopleDtoSchema exactly.
export const MergeVehiclesDtoSchema = z.object({
  survivingVehicleId: z.string().min(1),
  mergedVehicleId: z.string().min(1),
});
export type MergeVehiclesDto = z.infer<typeof MergeVehiclesDtoSchema>;

export const MergePropertiesDtoSchema = z.object({
  survivingPropertyId: z.string().min(1),
  mergedPropertyId: z.string().min(1),
});
export type MergePropertiesDto = z.infer<typeof MergePropertiesDtoSchema>;
