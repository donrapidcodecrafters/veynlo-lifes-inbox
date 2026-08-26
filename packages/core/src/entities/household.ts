import { z } from "zod";

/** §3.1 Principal types. */
export const PrincipalRoleSchema = z.enum([
  "individual_owner",
  "household_owner",
  "adult_member",
  "dependent_profile",
  "caregiver_delegate",
  "emergency_contact",
  "support_agent",
  "service_principal",
]);
export type PrincipalRole = z.infer<typeof PrincipalRoleSchema>;

export const UserStatusSchema = z.enum(["active", "suspended", "deletion_pending", "deleted"]);
export type UserStatus = z.infer<typeof UserStatusSchema>;

export const UserSchema = z.object({
  id: z.string(),
  email: z.string().email().nullable(),
  displayName: z.string(),
  locale: z.string().default("en-US"),
  timezone: z.string().default("UTC"),
  currency: z.string().length(3).default("USD"),
  status: UserStatusSchema,
  themePreference: z.enum(["system", "light", "dark"]).default("system"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  deletedAt: z.string().datetime().nullable(),
});
export type User = z.infer<typeof UserSchema>;

export const HouseholdSchema = z.object({
  id: z.string(),
  name: z.string(),
  billingOwnerUserId: z.string(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Household = z.infer<typeof HouseholdSchema>;

export const MembershipStatusSchema = z.enum(["invited", "active", "left", "removed"]);
export type MembershipStatus = z.infer<typeof MembershipStatusSchema>;

export const HouseholdMembershipSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  userId: z.string().nullable(), // null while pending a dependent w/o login
  role: PrincipalRoleSchema,
  relationshipLabel: z.string().nullable(), // "spouse", "child", "caregiver" — user-editable
  status: MembershipStatusSchema,
  invitedEmail: z.string().email().nullable(),
  joinedAt: z.string().datetime().nullable(),
  leftAt: z.string().datetime().nullable(),
});
export type HouseholdMembership = z.infer<typeof HouseholdMembershipSchema>;

/** FAM-001 — dependents may have no login of their own. */
export const DependentProfileSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  displayName: z.string(),
  birthDate: z.string().nullable(),
  guardianUserIds: z.array(z.string()),
  hasOwnAccount: z.boolean().default(false),
  linkedUserId: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type DependentProfile = z.infer<typeof DependentProfileSchema>;

/** FAM-006 — time-bound, revocable, scoped access; never blanket household access. */
export const CaregiverDelegationSchema = z.object({
  id: z.string(),
  householdId: z.string(),
  delegateUserId: z.string(),
  scopes: z.array(z.string()), // e.g. ["schedule:read", "emergency_binder:read"]
  expiresAt: z.string().datetime().nullable(),
  grantedByUserId: z.string(),
  grantedAt: z.string().datetime(),
  revokedAt: z.string().datetime().nullable(),
});
export type CaregiverDelegation = z.infer<typeof CaregiverDelegationSchema>;
