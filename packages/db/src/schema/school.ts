import { pgTable, text, timestamp, boolean, integer, jsonb, pgEnum, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households, dependentProfiles } from "./household";
import { encryptedText } from "./encrypted-type";

/**
 * §25 "School, Children & Activities" (SCH-001/002/005/006/007). Deliberately plain top-level tables, not
 * a `canonical_entities` subtype — same reasoning as `assets.ts`'s `propertyProfiles`/`vehicleProfiles`: a
 * school is a first-class object with its own strongly-typed shape (name/address), not an inferred graph
 * fact. `schoolEvents` is its own dedicated table rather than reusing `calendarEvents` with a
 * `source: "school"` tag — `calendarEvents.relatedEntityIds` (the column that would have carried the
 * child link) was confirmed dead code before this pass (grepped: declared in the schema, read nowhere;
 * see `ConflictService`'s own doc comment on the same finding), and a school event needs several
 * strongly-typed fields no calendar event has (which dependent, which school, ICS dedup key, drop-off/
 * pickup transport flags for the CAL-003 conflict extension below) — bolting those onto `calendar_events`
 * would mean widening a shared table for one domain's needs. Keeping school data in its own table also
 * matches spec's "School/child data defaults household-restricted" — a distinct table is a clean place to
 * reason about that visibility rule without touching every other calendar-event reader.
 */
export const permissionFormStateEnum = pgEnum("permission_form_state", [
  "discovered",
  "opened",
  "completed",
  "submitted",
  "confirmed",
]);

export const schools = pgTable(
  "schools",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    name: encryptedText("name").notNull(),
    address: encryptedText("address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schools_household_idx").on(t.householdId)],
);

/**
 * A school/district/teacher/team ICS-feed subscription (SCH-002), mirroring `connections`'s shape for the
 * `IcsAdapter` just closely enough to reuse its fetch/parse/dedup pattern without pulling school feeds
 * into the general-purpose connectors/OAuth machinery (a school ICS feed has no OAuth, no credential
 * vault entry worth the indirection — `icsUrl` is the entire credential, and it's typically a long
 * unguessable-token URL, which is why it's still an `encryptedText` column rather than plain `text`).
 * `kind: "forwarding_email"` deliberately does NOT create a new per-school inbound address — this app
 * already has one generic per-user inbound alias (`IdentityService.inboundAliasInfo`) that every forwarded
 * email routes through the same domain classifier (including the new "school" domain below), so a
 * forwarding-based school source is just a UI affordance ("forward this school's email to your Veynlo
 * address") over that existing pipeline, not a second ingestion path — `icsUrl` stays null for this kind.
 */
export const schoolSourceKindEnum = pgEnum("school_source_kind", ["ics", "forwarding_email"]);

export const schoolSources = pgTable(
  "school_sources",
  {
    id: text("id").primaryKey(),
    householdId: text("household_id")
      .notNull()
      .references(() => households.id, { onDelete: "cascade" }),
    schoolId: text("school_id").references(() => schools.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    label: encryptedText("label").notNull(), // e.g. "Lincoln Elementary district calendar", "Travel soccer team"
    kind: schoolSourceKindEnum("kind").notNull().default("ics"),
    icsUrl: encryptedText("ics_url"),
    health: text("health").notNull().default("initializing"), // "initializing" | "healthy" | "degraded" — mirrors connections.health
    // §28 encryption-inventory sweep — this comment already said "mirrors connections.health"; the
    // sibling column (connections.healthDetail) is encrypted, this one wasn't. Same write shape too
    // (school-ics.service.ts sets it from a caught error's message, same as worker-main.ts does for
    // connections.healthDetail).
    healthDetail: encryptedText("health_detail"),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    itemsDiscoveredCount: integer("items_discovered_count").notNull().default(0),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }), // "unsubscribe" — soft, mirrors connections.disconnectedAt
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("school_sources_household_idx").on(t.householdId)],
);

/**
 * One row per discovered/synced school or activity event (no-school day, picture day, conference, field
 * trip, fee due, game, practice, announcement). `dependentId` is nullable and MUST stay null rather than
 * guess whenever the household has 2+ dependents and the source evidence doesn't clearly name one (§25.1
 * "avoids guessing child identity when multiple candidates exist") — see
 * `IngestionService.extractSchool`'s doc comment for exactly how that's enforced, and
 * `SchoolService.assignChild` for the user-driven correction path.
 */
export const schoolEvents = pgTable(
  "school_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    schoolId: text("school_id").references(() => schools.id, { onDelete: "set null" }),
    schoolSourceId: text("school_source_id").references(() => schoolSources.id, { onDelete: "set null" }),
    dependentId: text("dependent_id").references(() => dependentProfiles.id, { onDelete: "set null" }),
    kind: text("kind").notNull(), // "no_school" | "picture_day" | "permission_deadline" | "conference" | "field_trip" | "fee_due" | "game" | "practice" | "announcement" | "other"
    title: encryptedText("title").notNull(),
    description: encryptedText("description"),
    start: jsonb("start").$type<TemporalValue>().notNull(),
    startSort: timestamp("start_sort", { withTimezone: true }),
    isAllDay: boolean("is_all_day").notNull().default(true),
    location: encryptedText("location"),
    // SCH-005 "arrival time... if sourced" — kept as a short free-text note (e.g. "arrive by 5:45pm for
    // warmups") rather than a second TemporalValue: the source rarely states a clean second timestamp, and
    // a note is honest about that instead of forcing an approximate time into a structured field.
    arrivalNote: encryptedText("arrival_note"),
    // Family transport-conflict extension (see conflict.service.ts's schoolTransportConflicts) — only true
    // for kinds where a specific pickup/drop-off actually applies (game/practice/field_trip) AND a
    // specific time was extracted; never fabricated for an all-day/no-time event.
    requiresDropoff: boolean("requires_dropoff").notNull().default(false),
    requiresPickup: boolean("requires_pickup").notNull().default(false),
    source: text("source").notNull().default("discovered_from_evidence"), // "discovered_from_evidence" | "feed" | "manual"
    providerEventId: text("provider_event_id"), // ICS feed dedup key, scoped by (schoolSourceId, providerEventId) — see school_events_source_provider_idx
    sourceEventId: text("source_event_id"), // evidence link — the source_events row this was discovered/synced from
    confidenceBand: text("confidence_band"),
    status: text("status").notNull().default("confirmed"), // "confirmed" | "canceled" — ICS cancellation reconciliation
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("school_events_household_start_idx").on(t.householdId, t.startSort),
    index("school_events_dependent_idx").on(t.dependentId),
    index("school_events_source_provider_idx").on(t.schoolSourceId, t.providerEventId),
  ],
);

/**
 * SCH-006 "Permission/form tracking" — state is evidence-based only: nothing here ever claims
 * "submitted"/"confirmed" without the user (or a matching confirmation email/receipt) actually saying so.
 * `discovered` is the only state a fresh extraction ever writes; every later state is a user action
 * (`SchoolService.advanceFormState`) or, if a later email explicitly confirms receipt, a subsequent
 * extraction linking to the same form via `findExistingPermissionForm`.
 */
export const permissionForms = pgTable(
  "permission_forms",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    schoolId: text("school_id").references(() => schools.id, { onDelete: "set null" }),
    dependentId: text("dependent_id").references(() => dependentProfiles.id, { onDelete: "set null" }),
    schoolEventId: text("school_event_id").references(() => schoolEvents.id, { onDelete: "set null" }),
    title: encryptedText("title").notNull(),
    state: permissionFormStateEnum("state").notNull().default("discovered"),
    dueDate: jsonb("due_date").$type<TemporalValue>(),
    dueDateSort: timestamp("due_date_sort", { withTimezone: true }),
    sourceEventId: text("source_event_id"), // evidence link — the discovery/confirmation email this state came from
    confidenceBand: text("confidence_band"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("permission_forms_household_due_idx").on(t.householdId, t.dueDateSort), index("permission_forms_dependent_idx").on(t.dependentId)],
);
