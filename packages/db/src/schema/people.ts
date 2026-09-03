import { pgTable, text, timestamp, boolean, integer, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households, dependentProfiles } from "./household";
import { connections } from "./connectors";
import { sensitivityTierEnum, visibilityEnum } from "./common";
import { encryptedText } from "./encrypted-type";

/**
 * §14 "Contacts, People & Relationships" (PEO-001..005). A Person is not a copied address-book row — it's
 * a first-class object (family member, provider, contractor, teacher, doctor, salesperson, friend,
 * emergency contact, or organization contact) with role-specific history and privacy, that MAY additionally
 * carry evidence from one or more synced address books via `contactSources`/`aliases`. Contact sources
 * remain evidence; the canonical `people` row can merge aliases across providers without ever overwriting
 * provider data unexpectedly (PEO-002 "Merge operations are reversible and preserve source mappings").
 *
 * Deliberately its own plain top-level table set, not built on `canonical_entities`/`relationships`
 * (packages/db/src/schema/graph.ts) even though that generic entity-resolution graph already reserved
 * `person`/`organization`/`relationship` id prefixes for exactly this domain (see packages/core/src/util/
 * ids.ts) — a Person here is a first-class object a user directly creates/edits/labels (same reasoning
 * `propertyProfiles`/`vehicleProfiles`/`petProfiles` give for their own plain-top-level-table style, see
 * assets.ts's doc comment), not a subtype inferred from ingested evidence the way a purchase line's
 * merchant entity is. `canonical_entities`/`graph.relationships` stay reserved for that different, evidence-
 * driven use; this module's `personRelationships` table below is a distinct, purely user-declared concept
 * ("Dr. Chen is Sarah's dentist"), not a generic-graph edge with a confidence score.
 */

export const organizations = pgTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    name: encryptedText("name").notNull(),
    // Free-form guidance, not enforced — "medical" | "school" | "contractor" | "financial" | "retail" | "other".
    organizationType: text("organization_type"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("organizations_owner_idx").on(t.ownerUserId)],
);

/**
 * PEO-003's own suggested relationship-label vocabulary — spec text: "Labels such as spouse/partner,
 * child, parent, caregiver, doctor, dentist, teacher, contractor, plumber, mechanic, accountant are
 * user-editable." Exported for UI pickers on both web and mobile; `people.relationshipLabel` itself stays
 * free text (never a DB enum) since the spec explicitly frames these as *suggested*, not exhaustive.
 */
export const PERSON_RELATIONSHIP_SUGGESTIONS = [
  "spouse_partner",
  "child",
  "parent",
  "sibling",
  "caregiver",
  "friend",
  "doctor",
  "dentist",
  "teacher",
  "contractor",
  "plumber",
  "mechanic",
  "accountant",
  "other",
] as const;

export const people = pgTable(
  "people",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    displayName: encryptedText("display_name").notNull(),
    organizationId: text("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    // Free text — see PERSON_RELATIONSHIP_SUGGESTIONS above for the suggested (not enforced) vocabulary.
    relationshipLabel: text("relationship_label"),
    // PEO-003 "inferred labels stay candidate unless high-confidence benign context" — "user_set" (typed or
    // confirmed directly by the user) | "suggested" (a low-confidence inferred label awaiting confirmation
    // — see PeopleService.suggestRelationshipLabel). A "suggested" label is surfaced distinctly in the UI
    // and never treated as authoritative (never drives ACL/notification/reminder decisions) until the user
    // confirms it, which flips this back to "user_set". Manual labeling is the safe default this codebase
    // deliberately doesn't over-invest past — see PeopleService's own doc comment.
    relationshipLabelSource: text("relationship_label_source").notNull().default("user_set"),
    isImportant: boolean("is_important").notNull().default(false),
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }),
    // PEO-004 "provider/contractor history" generic linking mechanism — mirrors calendarEvents.
    // relatedEntityIds/tasks.relatedEntityIds/documents.linkedEntityIds exactly (see schedule.ts/
    // documents.ts): plain ids of maintenanceRecords/bills/documents/calendarEvents/tasks/warranties/
    // vehicleProfiles/propertyProfiles this person is associated with (e.g. "the plumber who worked on
    // this maintenanceRecords row"), resolved by id-prefix in application code (PeopleService.personDetail)
    // the same way every other relatedEntityIds column in this codebase is — no migration needed on any of
    // those other domains' own tables.
    relatedEntityIds: jsonb("related_entity_ids").$type<string[]>().notNull().default([]),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("sensitive"),
    // PEO-001 "avoid sensitive identity inference beyond product need" + private-by-default — mirrors
    // HealthLogisticsService/SavedMemories' own stance exactly (see health-logistics.service.ts's class
    // doc comment): a personal contact (a friend, an ex, a private provider) is NOT visible to another
    // household member just because they're active in the household. Only an explicit "household"
    // visibility (set by the owner — e.g. for a shared family doctor) OR's household membership into
    // access at all; a still-"private" row stays invisible even to an otherwise-active household member.
    // "selected_people"/"shared_link" states are also used, same enum SharingService's other consumers use.
    visibility: visibilityEnum("visibility").notNull().default("private"),
    // PEO-002 reversible merge — mirrors merchants.mergedIntoMerchantId (commerce.ts) exactly: a
    // merged-away person row is excluded from normal list/detail queries but never hard-deleted, so
    // PeopleService.unmergePeople can fully restore it later.
    mergedIntoPersonId: text("merged_into_person_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("people_owner_idx").on(t.ownerUserId),
    index("people_household_idx").on(t.householdId),
    index("people_organization_idx").on(t.organizationId),
  ],
);

/** PEO-002 reversible-merge lineage — mirrors `merchantMergeLineage` (commerce.ts) field-for-field, adapted
 * to this domain's five satellite tables (contactSources/aliases/notes/importantDates/relationships)
 * instead of merchants' three (purchases/storeCredits/recurringStreams). See AdminService.mergeMerchants'
 * own doc comment for the shared design this mirrors. */
export const personMergeLineage = pgTable(
  "person_merge_lineage",
  {
    id: text("id").primaryKey(),
    survivingPersonId: text("surviving_person_id")
      .notNull()
      .references(() => people.id),
    mergedPersonId: text("merged_person_id")
      .notNull()
      .references(() => people.id),
    mergedPersonSnapshot: jsonb("merged_person_snapshot").$type<Record<string, unknown>>().notNull(),
    repointedContactSourceIds: jsonb("repointed_contact_source_ids").$type<string[]>().notNull().default([]),
    repointedAliasIds: jsonb("repointed_alias_ids").$type<string[]>().notNull().default([]),
    repointedNoteIds: jsonb("repointed_note_ids").$type<string[]>().notNull().default([]),
    repointedImportantDateIds: jsonb("repointed_important_date_ids").$type<string[]>().notNull().default([]),
    // Relationship rows repointed either direction (fromPersonId === mergedPersonId, or
    // toPersonId === mergedPersonId) — see PeopleService.mergePeople's own comment.
    repointedRelationshipIds: jsonb("repointed_relationship_ids").$type<string[]>().notNull().default([]),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mergedAt: timestamp("merged_at", { withTimezone: true }).notNull().defaultNow(),
    unmergedAt: timestamp("unmerged_at", { withTimezone: true }),
  },
  (t) => [index("person_merge_lineage_surviving_idx").on(t.survivingPersonId)],
);

/**
 * PEO-001 "Contact connectors" evidence rows — one per (person, provider) link. `providerContactId` is the
 * provider's own opaque resource id (Google People API `resourceName`, Microsoft Graph contact `id`), kept
 * so an incremental sync can find/update the same person row rather than creating a duplicate on every run
 * — the identical role `sourceEvents`/`connections` cursor state plays elsewhere, scoped per-contact here
 * since a whole-connection cursor alone can't tell you which LOCAL person a given provider contact maps to.
 */
export const contactSources = pgTable(
  "contact_sources",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "google" | "microsoft" | "apple_local" | "manual" — "apple_local" is a one-time device-contacts
    // import (PEO-001's device-permission path — see the mobile expo-contacts import flow), not a synced
    // connection, so `connectionId` stays null for it; "manual" (a person typed in directly, no provider
    // evidence at all) is the default for every person created without any import.
    provider: text("provider").notNull(),
    connectionId: text("connection_id").references(() => connections.id, { onDelete: "set null" }),
    providerContactId: encryptedText("provider_contact_id"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("contact_sources_person_idx").on(t.personId),
    index("contact_sources_owner_provider_idx").on(t.ownerUserId, t.provider),
  ],
);

/**
 * PEO-002 "Identity resolution combines normalized email/phone... aliases" — one row per known
 * email/phone/name-variant for a person, decrypted and normalized in application code
 * (PeopleService.findMergeCandidates) the same way AdminService.findDuplicateMerchantCandidates already
 * normalizes+groups decrypted merchant display names in memory rather than via a SQL-side hash/index —
 * consistent with this codebase's existing precedent for matching over encrypted text.
 */
export const aliases = pgTable(
  "aliases",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "email" | "phone" | "name_variant"
    value: encryptedText("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("aliases_person_idx").on(t.personId), index("aliases_owner_idx").on(t.ownerUserId)],
);

/**
 * PEO-003/PEO-004 user-declared relationship edges between people, or between a person and an existing
 * household member (`dependentProfiles` — see household.ts) — e.g. "Dr. Chen is Sarah's dentist," "Maria
 * is Tom's sister." Exactly one of `toPersonId`/`toDependentProfileId` is set, enforced in application code
 * (same "exactly one of N nullable FKs" pattern `maintenanceRecords`/`recallMatches` already use — see
 * assets.ts's doc comments). Deliberately separate from `graph.relationships` (see this file's own top
 * doc comment) — this is a plain user assertion with no confidence score or evidence link, not a
 * generic-entity-resolution edge.
 */
export const personRelationships = pgTable(
  "person_relationships",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fromPersonId: text("from_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    toPersonId: text("to_person_id").references(() => people.id, { onDelete: "cascade" }),
    toDependentProfileId: text("to_dependent_profile_id").references(() => dependentProfiles.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // free text, e.g. "dentist", "sister", "coach"
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("person_relationships_from_idx").on(t.fromPersonId), index("person_relationships_to_person_idx").on(t.toPersonId)],
);

export const personNotes = pgTable(
  "person_notes",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    authorUserId: text("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: encryptedText("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("person_notes_person_idx").on(t.personId)],
);

/**
 * PEO-005 "Important dates" — birthdays/anniversaries/renewals, wired into AttentionService.scanAndFileDeadlines
 * (see attention.ts) the same way `dependentProfiles.birthDate` already feeds ResurfacingService's yearly
 * birthday trigger. `isSensitive` is independent of the parent person's own `visibility` — a shared family
 * doctor's birthday is fine to surface household-wide, but a household member's therapist's birthday stays
 * owner-only regardless of how the therapist Person row itself is shared (checked independently in
 * PeopleService/AttentionService, never inferred from the category name).
 */
export const personImportantDates = pgTable(
  "person_important_dates",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: text("label").notNull(), // e.g. "Birthday", "Anniversary", "Policy renewal"
    date: jsonb("date").$type<TemporalValue>().notNull(),
    dateSort: timestamp("date_sort", { withTimezone: true }),
    isSensitive: boolean("is_sensitive").notNull().default(false),
    reminderDaysBefore: integer("reminder_days_before").notNull().default(14),
    // Recurrence guard for the yearly attention-scan trigger — same role as resurfacingRules.lastFiredAt
    // (memories.ts) / RECURRENCE_GAP_MS in resurfacing.service.ts, so the same occurrence never double-files
    // and a later year's occurrence still fires again.
    lastRemindedAt: timestamp("last_reminded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("person_important_dates_person_idx").on(t.personId), index("person_important_dates_date_sort_idx").on(t.dateSort)],
);
