import { z } from "zod";
import { NormalizedEmailSchema } from "../../common/normalized-email";

export const CreateAdminDtoSchema = z.object({
  email: NormalizedEmailSchema,
  displayName: z.string().min(1).max(120),
  role: z.enum(["support", "superadmin"]).default("support"),
});
export type CreateAdminDto = z.infer<typeof CreateAdminDtoSchema>;

export const GrantEntitlementDtoSchema = z.object({
  planKey: z.enum(["free", "plus", "family", "pro_agent"]),
  reason: z.string().min(1).max(500),
  // null = indefinite (e.g. grandfathering); a number = a time-boxed comp (e.g. "one free month for a bug they hit").
  durationDays: z.number().int().positive().max(3653).nullable(),
});
export type GrantEntitlementDto = z.infer<typeof GrantEntitlementDtoSchema>;

/** "Pre-launch private testing distribution" (docs/ROADMAP.md) — both fields optional: no email means any
 * address can redeem the code, no expiresInDays means the invite never expires on its own (it can still be
 * revoked). */
export const CreateSignupInviteDtoSchema = z.object({
  email: NormalizedEmailSchema.optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});
export type CreateSignupInviteDto = z.infer<typeof CreateSignupInviteDtoSchema>;

/** A reason is required (unlike e.g. entitlement revoke) because suspension is a much more consequential,
 * user-visible action — every suspension should leave an auditable "why" behind, same posture as
 * GrantEntitlementDto.reason. */
export const SuspendUserDtoSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type SuspendUserDto = z.infer<typeof SuspendUserDtoSchema>;
