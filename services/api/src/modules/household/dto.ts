import { z } from "zod";
import { NormalizedEmailSchema } from "../../common/normalized-email";

export const CreateHouseholdDtoSchema = z.object({
  name: z.string().min(1).max(120),
});
export type CreateHouseholdDto = z.infer<typeof CreateHouseholdDtoSchema>;

export const RenameHouseholdDtoSchema = z.object({
  name: z.string().min(1).max(120),
});
export type RenameHouseholdDto = z.infer<typeof RenameHouseholdDtoSchema>;

export const TransferOwnershipDtoSchema = z.object({
  targetUserId: z.string().min(1),
});
export type TransferOwnershipDto = z.infer<typeof TransferOwnershipDtoSchema>;

export const SetMemberLabelDtoSchema = z.object({
  relationshipLabel: z.string().max(60).nullable(),
});
export type SetMemberLabelDto = z.infer<typeof SetMemberLabelDtoSchema>;

export const DeclineInviteDtoSchema = z.object({
  token: z.string().min(1),
});
export type DeclineInviteDto = z.infer<typeof DeclineInviteDtoSchema>;

export const InviteMemberDtoSchema = z.object({
  email: NormalizedEmailSchema,
  relationshipLabel: z.string().max(60).nullable().optional(),
});
export type InviteMemberDto = z.infer<typeof InviteMemberDtoSchema>;

export const AcceptInviteDtoSchema = z.object({
  token: z.string().min(1),
});
export type AcceptInviteDto = z.infer<typeof AcceptInviteDtoSchema>;

export const CreateDependentDtoSchema = z.object({
  displayName: z.string().min(1).max(120),
  birthDate: z.string().nullable().optional(),
});
export type CreateDependentDto = z.infer<typeof CreateDependentDtoSchema>;

/**
 * FAM-001 "later invite/transition path when appropriate" — a guardian/adult member inviting a dependent
 * profile to link its own account. Deliberately admin-initiated only (no self-serve path for the dependent
 * to kick this off) — the spec's own permissions line for this whole section ("Guardian/household policy
 * required") gives no signal that a minor-in-progress should be able to grant themselves account access,
 * and admin-initiated is the safer default for something that changes who can act as this profile.
 */
export const InviteDependentTransitionDtoSchema = z.object({
  email: NormalizedEmailSchema,
});
export type InviteDependentTransitionDto = z.infer<typeof InviteDependentTransitionDtoSchema>;

export const AcceptDependentTransitionDtoSchema = z.object({
  token: z.string().min(1),
});
export type AcceptDependentTransitionDto = z.infer<typeof AcceptDependentTransitionDtoSchema>;

/**
 * FAM-006 "time-bound, revocable, scoped access; never blanket household access." Scopes cover the
 * household-adjacent data domains that actually exist today — deliberately not including
 * "emergency_binder:*" (that's only an entitlement/plan-capability flag right now, per
 * packages/core/src/entitlements/plans.ts; there's no emergency-binder feature/data to scope access to
 * yet). Note this DTO only validates the *shape* of a grant — enforcement itself lives in each consuming
 * service's own ownerOrDelegatedHousehold helper (CommerceService, DocumentsService, ScheduleService, all
 * calling HouseholdService.delegatedHouseholdIds), not here. "household:read" is currently unenforced —
 * there's no dedicated household-data read path beyond membership listing, which uses assertOwnerOrAdult
 * instead of a delegation scope.
 */
// §27 "Health Logistics" (HLTH-005 "guardians can share selected appointment/prep/emergency information
// with caregiver ... avoid blanket medical history access") — a dedicated scope rather than reusing
// "household:read"/"documents:read": those are broader household-context grants, while "health:read" is
// checked by HealthLogisticsService's own access-control helper (never OR'd in from plain
// activeHouseholdIds the way every other domain's ownerOrDelegatedHousehold does) — see that service's own
// doc comment for why health-logistics rows are private-by-default even to a household member.
//
// "trips:read" gap fix, found live during a requirements re-audit: TripsService.ownerOrDelegatedHousehold/
// assertTripAccess/redeemTravelCredit already call `delegatedHouseholdIds(userId, "trips:read")` (added
// when Phase 3 travel shipped, mirroring every other domain's identically-shaped helper), but this enum —
// the only thing GrantDelegationDtoSchema actually validates a caller's `scopes` array against — never
// included it. Since trips already OR's in plain `activeHouseholdIds` too, no household member was ever
// denied trip visibility because of this (delegation is always a subset of active membership, per
// `delegatedHouseholdIds`'s own doc comment), so this was a dead/uncreatable scope rather than a visibility
// leak — but it meant a caregiver delegation could never actually be scoped to "just trips," contradicting
// FAM-006's own "scoped access" framing for the one domain that had wired up a scope check for it.
//
// §28 "Pets" PET-001 — "Pet is a household entity with configurable managers" / user action "assign
// household manager" was never built: every other scope here is read-only visibility (every domain's own
// `ownerOrDelegatedHousehold` already OR's in plain active membership for reads, so a "*:read" delegation
// only ever widens visibility to non-members/ex-members' edge cases). Pets is different — PetsService.list/
// detail already show a shared pet to every active household member (PetsService.ownerOrDelegatedHousehold),
// but `update`/`remove` are hard owner-only (`assertOwnedPet`), so nobody but whoever originally added the
// pet can ever edit it or its records — the literal gap PET-001 calls out. Rather than a new schema
// concept (a `canManage` column, a parallel grants table), this reuses the exact same
// scoped/time-bound/revocable delegation mechanism every other domain already has, since it already fits
// "assign household manager" precisely: a "pets:manage" delegation is a household member (checked by
// PetsService.assertOwnedPet, OR'd alongside plain ownership) another member has explicitly authorized to
// edit shared pets, not a blanket admin right. The first WRITE-capability scope here rather than a "*:read"
// one — deliberately still household-scoped, not global, matching every other delegation's own "one
// household at a time" shape.
export const CAREGIVER_DELEGATION_SCOPES = [
  "schedule:read",
  "documents:read",
  "commerce:read",
  "household:read",
  "lists:read",
  "health:read",
  "trips:read",
  "pets:manage",
  // §14 Contacts, People & Relationships (PEO-001) — lets a caregiver see a household's explicitly
  // household-visible people (PeopleService never OR's plain activeHouseholdIds membership into access,
  // same private-by-default discipline as "health:read" — see people.ts's own schema doc comment).
  "people:read",
] as const;

export const GrantDelegationDtoSchema = z.object({
  delegateUserId: z.string().min(1),
  scopes: z.array(z.enum(CAREGIVER_DELEGATION_SCOPES)).min(1),
  expiresAt: z.string().datetime().nullable().optional(),
});
export type GrantDelegationDto = z.infer<typeof GrantDelegationDtoSchema>;
