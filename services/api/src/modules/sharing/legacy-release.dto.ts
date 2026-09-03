import { z } from "zod";
import { NormalizedEmailSchema } from "../../common/normalized-email";

/** §35 SHARE-006 "Optional preconfigured release of selected information" — the categories this reuses
 * from EmergencyBinderService.getBinder's own aggregate shape (see LegacyReleaseService's own doc comment
 * for why it draws from the same household aggregate rather than arbitrary per-resource sharing). */
export const LEGACY_RELEASE_CATEGORIES = [
  "household_roster",
  "vehicles",
  "properties",
  "pets",
  "identity_records",
  "documents",
  "medications_notes",
  "emergency_instructions",
] as const;
export type LegacyReleaseCategory = (typeof LEGACY_RELEASE_CATEGORIES)[number];

export const CreateLegacyReleaseConfigDtoSchema = z.object({
  householdId: z.string().optional(),
  trustedContactEmail: NormalizedEmailSchema,
  categories: z.array(z.enum(LEGACY_RELEASE_CATEGORIES)).min(1),
  // "Waiting period... must be explicit" — a floor high enough that it can't function as a near-instant
  // release (defeating the entire "no automatic account takeover" safeguard), no fixed ceiling since this
  // is deliberately the owner's own choice.
  waitingPeriodDays: z.number().int().min(7).max(365),
  inactivityThresholdDays: z.number().int().positive().max(3650).optional(),
});
export type CreateLegacyReleaseConfigDto = z.infer<typeof CreateLegacyReleaseConfigDtoSchema>;

export const ConfirmLegacyReleaseConfigDtoSchema = z.object({
  password: z.string().min(1),
});
export type ConfirmLegacyReleaseConfigDto = z.infer<typeof ConfirmLegacyReleaseConfigDtoSchema>;
