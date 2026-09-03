import { pgTable, text, timestamp, boolean, pgEnum, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { encryptedText } from "./encrypted-type";

export const principalRoleEnum = pgEnum("principal_role", [
  "individual_owner",
  "household_owner",
  "adult_member",
  "dependent_profile",
  "caregiver_delegate",
  "emergency_contact",
  "support_agent",
  "service_principal",
]);

export const membershipStatusEnum = pgEnum("membership_status", ["invited", "active", "left", "removed"]);

export const households = pgTable("households", {
  id: text("id").primaryKey(),
  name: encryptedText("name").notNull(),
  billingOwnerUserId: text("billing_owner_user_id")
    .notNull()
    .references(() => users.id),
  // Phase 2 §52.2 "emergency binder" — the packet's only genuinely-new data (everything else it surfaces —
  // members, vehicles, properties, flagged documents — already lives in its own domain table and is just
  // read/aggregated, not duplicated here). Deliberately two plain free-text fields on the household itself
  // rather than a new one-row-per-household table or a full medications-tracking domain: a real med list
  // (dosages, schedules, prescribers) and a real contacts/CRM domain are both separately-reserved Phase 2
  // future features (spec §53) that this pass is explicitly not building — "one text box a family can jot
  // what a first responder needs into" is the deliberately small scope that's actually in front of us.
  // encryptedText to match every other free-text field of this sensitivity (e.g. calendarEvents.location).
  medicationsNotes: encryptedText("medications_notes"),
  emergencyInstructions: encryptedText("emergency_instructions"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const householdMemberships = pgTable(
  "household_memberships",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    role: principalRoleEnum("role").notNull(),
    relationshipLabel: encryptedText("relationship_label"),
    status: membershipStatusEnum("status").notNull().default("invited"),
    // Stays plaintext: looked up by equality when checking for an existing pending invite
    // (household.service.ts) — same non-deterministic-encryption constraint as users.email.
    invitedEmail: text("invited_email"),
    // Only set while status = "invited" — the emailed accept-invite link's credential, same
    // hash-at-rest/single-use shape as passwordResetTokens (see identity.ts). Cleared once accepted;
    // status becoming "active" is itself the "used" marker, so no separate usedAt column is needed here.
    inviteTokenHash: text("invite_token_hash").unique(),
    inviteTokenExpiresAt: timestamp("invite_token_expires_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (t) => [index("household_memberships_household_idx").on(t.householdId)],
);

export const dependentProfiles = pgTable("dependent_profiles", {
  id: text("id").primaryKey(),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  displayName: encryptedText("display_name").notNull(),
  birthDate: encryptedText("birth_date"),
  guardianUserIds: jsonb("guardian_user_ids").$type<string[]>().notNull().default([]),
  hasOwnAccount: boolean("has_own_account").notNull().default(false),
  linkedUserId: text("linked_user_id").references(() => users.id, { onDelete: "set null" }),
  // FAM-001 "later invite/transition path when appropriate" — a dependent-to-own-account transition invite,
  // shaped exactly like householdMemberships' own invitedEmail/inviteTokenHash/inviteTokenExpiresAt trio
  // (same non-deterministic-encryption constraint on the email — see that table's own comment — and the
  // same hash-at-rest/single-use token shape). Lives on this row rather than a new householdMemberships
  // "invited" row because the thing being invited is a specific dependent profile, not a fresh generic
  // member slot: HouseholdService.acceptDependentTransition needs to resolve straight from the token back
  // to *this* profile to set hasOwnAccount/linkedUserId, and a household can have any number of dependents
  // each with at most one pending transition invite at a time. Cleared (both token columns) once accepted
  // or revoked; transitionInvitedEmail is left in place afterward for the same historical-record reason
  // householdMemberships never clears its own invitedEmail.
  transitionInvitedEmail: text("transition_invited_email"),
  transitionInviteTokenHash: text("transition_invite_token_hash").unique(),
  transitionInviteTokenExpiresAt: timestamp("transition_invite_token_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const caregiverDelegations = pgTable("caregiver_delegations", {
  id: text("id").primaryKey(),
  householdId: text("household_id")
    .notNull()
    .references(() => households.id, { onDelete: "cascade" }),
  delegateUserId: text("delegate_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // A delegation authorized by someone who's since deleted their account is no longer a valid
  // authorization, so it cascades away with them — same reasoning as resourceGrants/shareLinks below.
  grantedByUserId: text("granted_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** HH-002 — object-level sharing. resourceType/resourceId form a polymorphic reference checked by the authz layer. */
export const resourceGrants = pgTable(
  "resource_grants",
  {
    id: text("id").primaryKey(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    granteeUserId: text("grantee_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    right: text("right").notNull(), // "view" | "edit" | "manage"
    // SHARE-001 "optional message" — a short free-text note from the granter to the grantee, shown on the
    // shared resource's detail page as "Note from <granter>: ...". Nullable: most grants carry none.
    message: text("message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // A grant authorized by someone who's since deleted their account is no longer valid — cascades away
    // with them, same as caregiverDelegations.grantedByUserId above.
    grantedByUserId: text("granted_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("resource_grants_resource_idx").on(t.resourceType, t.resourceId)],
);

export const shareLinks = pgTable("share_links", {
  id: text("id").primaryKey(),
  resourceType: text("resource_type").notNull(),
  resourceId: text("resource_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  // A share link created by someone who's since deleted their account should stop working — cascades
  // away with them, same reasoning as the grant tables above.
  createdByUserId: text("created_by_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  passcodeHash: text("passcode_hash"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
