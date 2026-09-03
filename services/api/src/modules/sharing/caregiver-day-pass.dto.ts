import { z } from "zod";

/** §35 SHARE-005 "Schedule, contacts, access instructions, pet/kid tasks" — the four logistics categories
 * the spec names, with "pet/kid tasks" split into two independently toggle-able scopes (a sitter watching
 * only pets doesn't need the kids' school pickup schedule, and vice versa). See
 * CaregiverDayPassService.buildPacket for what each one actually includes. */
export const CAREGIVER_DAY_PASS_SCOPES = ["schedule", "contacts", "instructions", "pets", "dependents"] as const;
export type CaregiverDayPassScope = (typeof CAREGIVER_DAY_PASS_SCOPES)[number];

export const CreateCaregiverDayPassDtoSchema = z.object({
  label: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(CAREGIVER_DAY_PASS_SCOPES)).min(1),
  // "Time-bound" is the whole point of SHARE-005 (unlike resourceGrants/shareLinks, there is no "until
  // revoked" option) — bounded to a sensible "day pass" window, not an open-ended share.
  expiresInHours: z.number().int().positive().max(72),
  passcode: z.string().min(4).max(100).optional(),
});
export type CreateCaregiverDayPassDto = z.infer<typeof CreateCaregiverDayPassDtoSchema>;

export const AccessCaregiverDayPassDtoSchema = z.object({
  passcode: z.string().max(100).optional(),
});
export type AccessCaregiverDayPassDto = z.infer<typeof AccessCaregiverDayPassDtoSchema>;
