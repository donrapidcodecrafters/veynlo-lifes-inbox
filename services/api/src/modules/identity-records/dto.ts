import { z } from "zod";

/**
 * "Identity & Legal Continuity" (ID-001 passport, ID-002 driver's license/state ID, ID-003 vehicle
 * registration, ID-004 professional/recreational licenses, ID-005 property/government obligations). Single
 * source of truth for the `identity_records.record_type` value set — same "enum lives in the service layer,
 * the column is plain text" precedent as `PRICE_ADJUSTMENT_POLICY_CONFIDENCES`
 * (commerce/price-adjustment-policy.ts) — so packages/db's schema file stays free of a service-layer import.
 */
export const IDENTITY_RECORD_TYPES = ["passport", "drivers_license", "vehicle_registration", "professional_license", "property_obligation"] as const;
export type IdentityRecordType = (typeof IDENTITY_RECORD_TYPES)[number];

export const IDENTITY_RECORD_TYPE_LABELS: Record<IdentityRecordType, string> = {
  passport: "passport",
  drivers_license: "driver's license",
  vehicle_registration: "vehicle registration",
  professional_license: "professional/recreational license",
  property_obligation: "property/government obligation",
};

export const IDENTITY_RECORD_STATUSES = ["active", "expired", "renewed"] as const;
export type IdentityRecordStatus = (typeof IDENTITY_RECORD_STATUSES)[number];

/** ID-001..005 "Scan/add" manual-entry shape. `documentNumber` is the one field IdentityRecordsService
 * never returns from a normal read — see identity-records.util.ts's `identityRecordSafeColumns`. */
export const CreateIdentityRecordDtoSchema = z.object({
  recordType: z.enum(IDENTITY_RECORD_TYPES),
  label: z.string().min(1).max(200),
  issuingAuthority: z.string().max(200).nullable().optional(),
  documentNumber: z.string().max(200).nullable().optional(),
  issuedIso: z.string().nullable().optional(),
  expirationIso: z.string().nullable().optional(),
  jurisdiction: z.string().max(20).nullable().optional(),
  linkedVehicleId: z.string().nullable().optional(),
  linkedPropertyId: z.string().nullable().optional(),
  reminderLeadDays: z.number().int().min(1).max(3650).optional(),
  householdId: z.string().nullable().optional(),
});
export type CreateIdentityRecordDto = z.infer<typeof CreateIdentityRecordDtoSchema>;

/** Owner-only edit — never step-up gated (only *reading* `documentNumber` back via `revealDocumentNumber`
 * is; see that method's own doc comment on IdentityRecordsService for why editing and revealing get
 * different gates, same posture `vehicleProfiles.vin` already has). */
export const UpdateIdentityRecordDtoSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  issuingAuthority: z.string().max(200).nullable().optional(),
  documentNumber: z.string().max(200).nullable().optional(),
  issuedIso: z.string().nullable().optional(),
  expirationIso: z.string().nullable().optional(),
  jurisdiction: z.string().max(20).nullable().optional(),
  linkedVehicleId: z.string().nullable().optional(),
  linkedPropertyId: z.string().nullable().optional(),
  renewalUrl: z.string().max(2000).nullable().optional(),
  reminderLeadDays: z.number().int().min(1).max(3650).optional(),
});
export type UpdateIdentityRecordDto = z.infer<typeof UpdateIdentityRecordDtoSchema>;

/** ID-001..005 "attach new version"/"mark renewed" — omitted fields simply carry over unchanged from the
 * record being renewed (see IdentityRecordsService.renewRecord). */
export const RenewIdentityRecordDtoSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  issuingAuthority: z.string().max(200).nullable().optional(),
  documentNumber: z.string().max(200).nullable().optional(),
  issuedIso: z.string().nullable().optional(),
  expirationIso: z.string().nullable().optional(),
});
export type RenewIdentityRecordDto = z.infer<typeof RenewIdentityRecordDtoSchema>;

/** "Reveal/copy protected field" — §28.9 step-up shape, identical to every other reveal-gated action in
 * this app (OpenHealthDocumentDtoSchema, EmergencyBinderService.getBinder). */
export const RevealDocumentNumberDtoSchema = z.object({
  password: z.string().optional(),
});
export type RevealDocumentNumberDto = z.infer<typeof RevealDocumentNumberDtoSchema>;

export const LinkIdentityDocumentDtoSchema = z.object({
  documentId: z.string().min(1),
});
export type LinkIdentityDocumentDto = z.infer<typeof LinkIdentityDocumentDtoSchema>;

/** RET-004-shaped user correction for the curated jurisdiction-renewal-link registry (see
 * jurisdiction-link-resolver.ts). Always writes/updates `ownerUserId`-scoped rows — a personal correction
 * never becomes a global fact for every other user, same stance `setUserPriceAdjustmentPolicy` takes. */
export const SetJurisdictionLinkDtoSchema = z.object({
  recordType: z.enum(IDENTITY_RECORD_TYPES),
  jurisdiction: z.string().min(1).max(20),
  url: z.string().url().max(2000),
  label: z.string().min(1).max(200),
  sourceNote: z.string().max(1000).nullable().optional(),
});
export type SetJurisdictionLinkDto = z.infer<typeof SetJurisdictionLinkDtoSchema>;
