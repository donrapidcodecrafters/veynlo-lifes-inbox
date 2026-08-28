import { z } from "zod";

export const CreateHouseholdDtoSchema = z.object({
  name: z.string().min(1).max(120),
});
export type CreateHouseholdDto = z.infer<typeof CreateHouseholdDtoSchema>;

export const InviteMemberDtoSchema = z.object({
  email: z.string().email(),
  relationshipLabel: z.string().max(60).nullable().optional(),
});
export type InviteMemberDto = z.infer<typeof InviteMemberDtoSchema>;

export const CreateDependentDtoSchema = z.object({
  displayName: z.string().min(1).max(120),
  birthDate: z.string().nullable().optional(),
});
export type CreateDependentDto = z.infer<typeof CreateDependentDtoSchema>;

/**
 * FAM-006 "time-bound, revocable, scoped access; never blanket household access." Scopes cover the
 * household-adjacent data domains that actually exist today — deliberately not including
 * "emergency_binder:*" (that's only an entitlement/plan-capability flag right now, per
 * packages/core/src/entitlements/plans.ts; there's no emergency-binder feature/data to scope access to
 * yet). Note this DTO only validates the *shape* of a grant — nothing outside HouseholdService currently
 * checks a caller's delegation scopes before serving schedule/documents/commerce data, so a delegation
 * exists and is queryable but isn't enforced anywhere yet; see docs/ROADMAP.md.
 */
export const CAREGIVER_DELEGATION_SCOPES = ["schedule:read", "documents:read", "commerce:read", "household:read"] as const;

export const GrantDelegationDtoSchema = z.object({
  delegateUserId: z.string().min(1),
  scopes: z.array(z.enum(CAREGIVER_DELEGATION_SCOPES)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type GrantDelegationDto = z.infer<typeof GrantDelegationDtoSchema>;
