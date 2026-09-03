import { z } from "zod";

/**
 * Phase 2 §52.2 "emergency binder" household-level free text (see households.medicationsNotes/
 * emergencyInstructions's own schema doc comment for why these are two plain fields, not a tracked
 * domain). Generous max length — this is meant to hold a real family's worth of medication names/dosages
 * or evacuation instructions, not a one-liner — but still bounded so it can't be used to smuggle
 * arbitrarily large blobs into an encrypted text column.
 */
export const UpdateEmergencyBinderSettingsDtoSchema = z.object({
  medicationsNotes: z.string().max(8000).nullable().optional(),
  emergencyInstructions: z.string().max(8000).nullable().optional(),
});
export type UpdateEmergencyBinderSettingsDto = z.infer<typeof UpdateEmergencyBinderSettingsDtoSchema>;

/** §28.9 step-up auth — same optional-password shape as data-export/connectors' step-up DTOs (see dto.ts
 * comments there): optional because it's only actually required for an account that has a password at all
 * (verifyStepUpPassword is a no-op for OAuth-only accounts). */
export const UnlockEmergencyBinderDtoSchema = z.object({
  password: z.string().optional(),
});
export type UnlockEmergencyBinderDto = z.infer<typeof UnlockEmergencyBinderDtoSchema>;
