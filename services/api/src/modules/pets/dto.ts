import { z } from "zod";

/**
 * PET-001 "pet profile" — mirrors CreateVehicleProfileDtoSchema/CreatePropertyProfileDtoSchema's shape
 * closely (see assets/dto.ts). `species`/`breed` are plain/low-sensitivity per this feature's own design
 * guidance; `microchipNumber` is genuinely identifying and stored encrypted (petProfiles.microchipNumber).
 */
export const CreatePetProfileDtoSchema = z.object({
  label: z.string().min(1).max(120),
  species: z.string().max(60).nullable().optional(),
  breed: z.string().max(60).nullable().optional(),
  birthDateIso: z.string().nullable().optional(),
  microchipNumber: z.string().max(64).nullable().optional(),
  vetProviderName: z.string().max(120).nullable().optional(),
  insuranceProviderName: z.string().max(120).nullable().optional(),
  insurancePolicyNumber: z.string().max(120).nullable().optional(),
  householdId: z.string().nullable().optional(),
});
export type CreatePetProfileDto = z.infer<typeof CreatePetProfileDtoSchema>;

/**
 * PET-001 "attach records ... mark renewed" and the "transferred ownership, deceased pet archival" edge
 * states — every field optional/independently settable after creation, unlike CreatePetProfileDtoSchema
 * (there was previously no way to attach a photo, set a vet/insurance provider after the fact, or archive a
 * pet at all). `lifecycleStatus` is the archival mechanism: never a hard delete, so a deceased/transferred
 * pet's vaccination/vet-visit/insurance history stays queryable (see petProfiles' own schema doc comment).
 */
export const UpdatePetProfileDtoSchema = z.object({
  label: z.string().min(1).max(120).optional(),
  species: z.string().max(60).nullable().optional(),
  breed: z.string().max(60).nullable().optional(),
  birthDateIso: z.string().nullable().optional(),
  microchipNumber: z.string().max(64).nullable().optional(),
  photoDocumentId: z.string().nullable().optional(),
  vetProviderName: z.string().max(120).nullable().optional(),
  insuranceProviderName: z.string().max(120).nullable().optional(),
  insurancePolicyNumber: z.string().max(120).nullable().optional(),
  lifecycleStatus: z.enum(["active", "deceased", "transferred"]).optional(),
  // Found live: CreatePetProfileDtoSchema already accepted householdId, but there was no way to assign or
  // change it after the fact — a pet added before its owner joined a household (or added while private by
  // choice) could never be made to show up in that household's Emergency Binder (EmergencyBinderService.
  // getBinder queries petProfiles by householdId alone). `null` explicitly means "make this pet private
  // again" — distinct from omitting the field, which leaves the existing association untouched. See
  // PetsService.update's own doc comment for the membership check this requires.
  householdId: z.string().nullable().optional(),
});
export type UpdatePetProfileDto = z.infer<typeof UpdatePetProfileDtoSchema>;

/**
 * PET-004 "vaccination/license records" — manual add path. `documentId`, when given, must already be an
 * uploaded document the caller owns/can see (checked in PetsService) — the underlying certificate/license
 * file itself goes through the ordinary Documents upload flow, never through this endpoint. `expirationDateIso`
 * is optional (a license/vaccine with no known expiration is still worth recording), and — per PET-004's
 * "deadline must be sourced/user-confirmed" — a manually created row is always `source: "user_confirmed"`,
 * set server-side, never accepted from the client (see PetsService.addVaccination).
 */
export const CreatePetVaccinationDtoSchema = z.object({
  label: z.string().min(1).max(120),
  documentId: z.string().nullable().optional(),
  expirationDateIso: z.string().nullable().optional(),
});
export type CreatePetVaccinationDto = z.infer<typeof CreatePetVaccinationDtoSchema>;

/**
 * PET-003 "medication/refill logistics" — see `refillReminders`' own schema doc comment for why this table
 * (and therefore this DTO) is deliberately plain: a medication NAME, a next refill/pickup date, and an
 * optional pharmacy. No dose/frequency/clinical field exists to accept here at all — the non-diagnostic
 * boundary is enforced by this DTO simply having nowhere to put that information, not by a runtime check.
 */
export const CreateRefillReminderDtoSchema = z.object({
  medicationName: z.string().min(1).max(200),
  nextRefillDateIso: z.string().min(1),
  pharmacy: z.string().max(120).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type CreateRefillReminderDto = z.infer<typeof CreateRefillReminderDtoSchema>;

// §40.1/40.2 "Entity Resolution" gap-close — reversible merge for pets, mirroring people/dto.ts's
// MergePeopleDtoSchema exactly.
export const MergePetsDtoSchema = z.object({
  survivingPetId: z.string().min(1),
  mergedPetId: z.string().min(1),
});
export type MergePetsDto = z.infer<typeof MergePetsDtoSchema>;
