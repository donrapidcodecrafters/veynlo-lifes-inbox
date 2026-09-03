import { pgTable, text, timestamp, jsonb, integer, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households, resourceGrants, shareLinks } from "./household";

/**
 * Chapter 35 "Sharing, Collaboration & Emergency Access" — SHARE-004/007's shared "Primary data / state"
 * list names `access_audit` alongside `resource_grants`/`share_links`/`share_projection`/
 * `emergency_packets`, but until now nothing in this codebase wrote to it: SharingService's own grant/link
 * mechanics (resourceGrants/shareLinks, both in household.ts) gate access but never RECORD that access
 * happened. This is the missing "who's viewed this" ledger — one row per successful read of a resource
 * reached through a grant or a public share link, so a resource's owner can see SHARE-007's "access
 * history" (not just "who currently has access", which listResourceGrants/listShareLinks already cover).
 *
 * Deliberately excludes the OWNER's own views of their own resource — this ledger exists to answer "who
 * did I share this with, and did they actually look at it," not to be a general page-view log. See
 * SharingService.hasActiveGrant/resolveShareLink for the two write sites (a non-owner's grant-gated read,
 * and any use of a public link), chosen because those are the exact points every resource module's own
 * single-object read path already calls to decide "does this non-owner get to see this."
 */
export const accessAuditEvents = pgTable(
  "access_audit_events",
  {
    id: text("id").primaryKey(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id").notNull(),
    // "grant" — an authenticated grantee read the resource through a resourceGrants row.
    // "share_link" — someone (no Veynlo session required) redeemed a public share_links token.
    accessMethod: text("access_method").notNull(),
    // Null for a share-link redemption — the whole point of SHARE-002 is that the recipient need not have
    // an account. Set for a grant-gated read, since a resourceGrant always names a real granteeUserId.
    // "set null" (not cascade): if the accessing account is later deleted, the fact that SOME access
    // occurred at this resource/time is still meaningful audit history for the resource's owner.
    accessedByUserId: text("accessed_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resourceGrantId: text("resource_grant_id").references(() => resourceGrants.id, { onDelete: "set null" }),
    shareLinkId: text("share_link_id").references(() => shareLinks.id, { onDelete: "set null" }),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("access_audit_events_resource_idx").on(t.resourceType, t.resourceId),
    index("access_audit_events_accessed_at_idx").on(t.accessedAt),
  ],
);

/**
 * SHARE-005 "Caregiver/day pass" — "Time-bound collection for caregiver logistics. Schedule, contacts,
 * access instructions, pet/kid tasks; automatically expires." Deliberately distinct from
 * `caregiverDelegations` (household.ts, FAM-006): a delegation grants an ALREADY-a-household-member an
 * ongoing, scoped read into the household's own data model (lists/tasks/bills/etc, enforced by each
 * domain's own `delegatedHouseholdIds` OR-branch) and requires a real Veynlo account. A day pass is the
 * opposite shape on every axis the spec calls out: for someone OUTSIDE the household (a babysitter/house-
 * sitter with no account at all — same "no account needed" posture as `shareLinks`), mandatorily
 * time-boxed (an expiry is required, not optional like `resourceGrants.expiresAt`), and carries no write
 * access at all — just a read-only, redacted logistics packet assembled fresh at redemption time from
 * whichever `scopes` the household member who created it chose to include.
 */
export const caregiverDayPasses = pgTable(
  "caregiver_day_passes",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    // A pass created by someone who's since deleted their account is no longer a valid authorization —
    // cascades away with them, same reasoning as caregiverDelegations/resourceGrants/shareLinks.
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // A short human label so the household can tell passes apart in the list view, e.g. "Sarah — Sat night".
    label: text("label").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    passcodeHash: text("passcode_hash"),
    // "Schedule, contacts, access instructions, pet/kid tasks" — each a separately toggle-able category so
    // the household isn't forced to hand over everything just to share, say, the WiFi password and feeding
    // instructions. See CaregiverDayPassService's own doc comment for the recognized values.
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    // NOT NULL, unlike resourceGrants.expiresAt/shareLinks.expiresAt — SHARE-005 is explicitly "time-bound"
    // by definition, so there is no "until revoked" option here.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    // Owner-initiated early revocation ("caregiver access ends mid-day" — SHARE-001's own failure-state
    // list, which SHARE-005 shares).
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // Set by the recurring expiry sweep (CaregiverDayPassService.expireDuePasses /
    // QueueProducerService.scheduleRecurringCaregiverDayPassScan) once `expiresAt` passes — distinct from
    // `revokedAt` so the UI/audit trail can tell "the household ended it early" from "it just ran out",
    // even though both make the pass equally unusable. The redemption path also checks `expiresAt` live
    // (same defense-in-depth as every other expiring token in this codebase), so a pass can never be used
    // past its window even in the window between expiry and the next sweep tick.
    expiredAt: timestamp("expired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("caregiver_day_passes_household_idx").on(t.householdId)],
);

/**
 * SHARE-006 "Future trusted delegate / legacy release" — "Optional preconfigured release of selected
 * information under a carefully verified process... no automatic account takeover. Release criteria,
 * waiting period, multi-party verification and revocation must be explicit."
 *
 * This models the full lifecycle including automatic trigger detection (see LegacyReleaseService's own doc
 * comment / scanInactivity for the recurring job): the owner's explicit, step-up-gated setup ("arming"), a
 * two-party admin-operated OR inactivity-triggered release process (one operator — a human admin, or the
 * scan job acting as "system" once the owner's own configured inactivity threshold is crossed — initiates
 * a mandatory waiting period, a SEPARATE superadmin-only operator finalizes it only after that period
 * elapses), an owner-side cancel-anytime-before-release safety valve, an earlier "are you still there?"
 * warning before the trigger actually fires, and redemption of exactly the categories the owner picked —
 * never a full account handover.
 */
export const legacyReleaseConfigs = pgTable(
  "legacy_release_configs",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The household whose roster/vehicles/properties/pets/identity-records/documents this config draws
    // from at redemption time — same aggregate shape as EmergencyBinderService.getBinder, just gated by
    // `categories` below instead of always returning everything. Nullable: an individual_owner with no
    // household can still release identity records/documents, just nothing household-scoped.
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    trustedContactEmail: text("trusted_contact_email").notNull(),
    // SHARE-006 "selected information" — which of EmergencyBinderService's own aggregate categories to
    // include. Recognized values: "household_roster", "vehicles", "properties", "pets",
    // "identity_records", "documents", "medications_notes", "emergency_instructions" — see
    // LegacyReleaseService's CATEGORY set.
    categories: jsonb("categories").$type<string[]>().notNull().default([]),
    // "Waiting period... must be explicit" — the mandatory delay between an admin-operated release being
    // initiated and it being eligible to finalize, during which the owner can cancel it (the proof they're
    // still there, per spec's "no automatic account takeover").
    waitingPeriodDays: integer("waiting_period_days").notNull(),
    // The owner's own "if I'm inactive for N days" release criterion — read by
    // LegacyReleaseService.scanInactivity (the recurring inactivity-scan job) against the real activity
    // signal on `users.lastActiveAt`. Null means this config has no inactivity trigger at all — it can
    // still be released, just only via a human admin manually calling initiateRelease, exactly as before
    // this column was acted on.
    inactivityThresholdDays: integer("inactivity_threshold_days"),
    // Set the moment the owner crosses the earlier "are you still there?" warning point (75% of
    // `inactivityThresholdDays` — see LegacyReleaseService's WARNING_THRESHOLD_FRACTION) so the scan job
    // sends that email at most once per inactivity spell instead of on every tick. Cleared back to null
    // once real activity is seen again (owner.lastActiveAt moves back inside the warning window), so a
    // LATER inactivity spell for the same still-armed config can warn again.
    inactivityWarningSentAt: timestamp("inactivity_warning_sent_at", { withTimezone: true }),
    // draft -> armed (owner step-up-confirmed) -> pending_release (admin initiated, waiting period running)
    // -> released (superadmin finalized after the wait) | revoked (owner cancelled outright) — with
    // pending_release able to fall back to armed via the owner's own cancel-pending-release action.
    status: text("status").notNull().default("draft"),
    // Set once, when the owner completes the step-up-password confirmation that arms this config — the
    // "clear, explicit multi-step confirmation... to set up" the task calls for.
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    // Which admin operator started the waiting period, and when — kept for the audit trail even after a
    // cancel/re-initiate cycle overwrites the timestamp.
    releaseInitiatedByAdminId: text("release_initiated_by_admin_id"),
    releaseInitiatedAt: timestamp("release_initiated_at", { withTimezone: true }),
    releaseEligibleAt: timestamp("release_eligible_at", { withTimezone: true }),
    // The second, distinct (superadmin-only) operator who finalized the release, and when.
    releaseFinalizedByAdminId: text("release_finalized_by_admin_id"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    // High-entropy redemption token, same shape as shareLinks.tokenHash — minted only at finalize time, so
    // a config sitting in "draft"/"armed"/"pending_release" has no live token to leak at all.
    releaseTokenHash: text("release_token_hash").unique(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("legacy_release_configs_owner_idx").on(t.ownerUserId)],
);
