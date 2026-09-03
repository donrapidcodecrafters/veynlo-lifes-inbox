import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { vehicleProfiles, propertyProfiles } from "./assets";
import { documents } from "./documents";
import { sensitivityTierEnum, visibilityEnum } from "./common";
import { encryptedText } from "./encrypted-type";

/**
 * §"Identity & Legal Continuity" (ID-001 passport, ID-002 driver's license/state ID, ID-003 vehicle
 * registration, ID-004 professional/recreational licenses, ID-005 property/government obligations) —
 * closes a gap TRIP-006 (built earlier this session) explicitly did NOT cover: TRIP-006 only compares the
 * generic Documents vault's `documentKind==="passport"`/`expiresAt` fields against upcoming trip dates. This
 * is the real dedicated domain the spec names — its own encrypted-at-rest record type, its own
 * user-configurable expiration reminders, versioning/renewal history, and a curated official-renewal-link
 * registry (`jurisdictionRenewalLinks` below) — rather than another ad hoc pair of columns bolted onto
 * `documents`.
 *
 * ACCESS CONTROL — "private by default; explicit share for emergency/travel packets" (spec). Mirrors
 * `healthAppointments`' strict stance exactly (see health.ts's own doc comment): `IdentityRecordsService`'s
 * read paths NEVER OR in plain household membership or a caregiver delegation, regardless of `visibility` —
 * only ownership or an explicit `resourceGrants` row (SharingService, resourceType "identity_record") ever
 * grants another user access. `householdId` exists ONLY so `EmergencyBinderService.getBinder` can aggregate
 * a household's identity records the same direct-by-householdId way it already aggregates vehicles/
 * properties/pets (itself gated behind the binder's own §28.9 step-up check) — it is never read by this
 * table's own access-control helper.
 */
export const identityRecords = pgTable(
  "identity_records",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    // "passport" | "drivers_license" | "vehicle_registration" | "professional_license" |
    // "property_obligation" — see IDENTITY_RECORD_TYPES (services/api's identity-records/dto.ts), the
    // single source of truth for this value set (same "enum lives in the service layer, column is plain
    // text" precedent as PRICE_ADJUSTMENT_POLICY_CONFIDENCES/commerce.ts's confidence column).
    recordType: text("record_type").notNull(),
    label: encryptedText("label").notNull(), // e.g. "US Passport", "CA Driver's License" — user-chosen
    issuingAuthority: encryptedText("issuing_authority"),
    // The single most sensitive field in this table (passport/license/plate number) — envelope-encrypted at
    // rest exactly like every other `encryptedText` column (see encrypted-type.ts's own doc comment), AND,
    // unlike `vehicleProfiles.vin`, deliberately excluded from every ordinary list/detail query in
    // `IdentityRecordsService` (see that file's `identityRecordSafeColumns`) — only the dedicated,
    // step-up-gated `revealDocumentNumber` ever selects this column at all. Treat as `vehicleProfiles.vin`'s
    // encryption precedent PLUS a read-time reveal gate `vin` doesn't have, since this field is materially
    // more sensitive (a government identity number, not a vehicle identifier).
    documentNumber: encryptedText("document_number"),
    issuedDate: jsonb("issued_date").$type<TemporalValue>(),
    expirationDate: jsonb("expiration_date").$type<TemporalValue>(),
    expirationDateSort: timestamp("expiration_date_sort", { withTimezone: true }),
    // ID-003 "link to vehicle object" / ID-005's property analog — a real FK to the caller's own
    // vehicleProfiles/propertyProfiles row, not a free-text label.
    linkedVehicleId: text("linked_vehicle_id").references(() => vehicleProfiles.id, { onDelete: "set null" }),
    linkedPropertyId: text("linked_property_id").references(() => propertyProfiles.id, { onDelete: "set null" }),
    // Optional scanned image/PDF of the document — reuses the existing Documents vault rather than a
    // parallel file-storage mechanism, same "same vault, sensitivity tier does the work" precedent HLTH-002's
    // insurance-card/EOB documents already established for this codebase.
    linkedDocumentId: text("linked_document_id").references(() => documents.id, { onDelete: "set null" }),
    // A loose jurisdiction key used to look up `jurisdictionRenewalLinks` — "US" for a federally-issued
    // record (a passport), "US-CA"/"US-NY"/... for a state-issued one. Free text (not a DB enum): a
    // jurisdiction this app hasn't curated a link for yet is still a legitimate value to record.
    jurisdiction: text("jurisdiction"),
    // A direct per-record override of the resolved jurisdiction-registry link (see
    // jurisdiction-link-resolver.ts) — null unless the user has explicitly pasted their own link for this
    // one record; the registry lookup is the fallback, not the other way around.
    renewalUrl: text("renewal_url"),
    // ID-001 "set reminder lead times" (user-configurable) — read directly by
    // AttentionService.scanAndFileDeadlines's own identity-records block instead of that scanner's fixed
    // 14-day LOOKAHEAD_MS window, since a sensible passport-renewal lead time (months) is far longer than a
    // bill's few days.
    reminderLeadDays: integer("reminder_lead_days").notNull().default(60),
    status: text("status").notNull().default("active"), // "active" | "expired" | "renewed"
    // Renewal/versioning chain (spec "attach new version"/"mark renewed") — set on the OLD row once
    // `IdentityRecordsService.renewRecord` creates a NEW row, pointing forward to that new row's id; the old
    // row is simultaneously marked status "renewed" and is never deleted (an audit trail, per spec's own
    // `audit_events` reference). Deliberately a plain text column with no hard `.references()` back to this
    // same table — a genuine self-reference — mirroring `documents.currentVersionId`'s identical
    // plain-text-forward-pointer precedent in this codebase for the same reason (expressing "the row that
    // supersedes me" as a real FK needs an awkward two-pass table definition Drizzle's builder doesn't
    // offer cleanly).
    supersededByRecordId: text("superseded_by_record_id"),
    sensitivity: sensitivityTierEnum("sensitivity").notNull().default("highly_sensitive"),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("identity_records_owner_idx").on(t.ownerUserId),
    index("identity_records_expiration_idx").on(t.expirationDateSort),
    index("identity_records_household_idx").on(t.householdId),
  ],
);

/**
 * jurisdiction_links — a small, RET-004-shaped curated reference table of REAL official-government renewal
 * URLs, keyed by (recordType, jurisdiction). See packages/db/src/seed/identity-jurisdiction-links.ts for the
 * actual seeded rows and that file's own sourcing discipline: only a handful of genuinely verified,
 * currently-live official .gov URLs, exactly like RET-004's `merchantPriceAdjustmentPolicies` seed — never a
 * live scrape/fetch, never an invented URL. `ownerUserId` null = a global seeded fact visible to everyone;
 * set = one user's own correction/addition for that (recordType, jurisdiction) pair — same precedence rule
 * as `merchantPriceAdjustmentPolicies` (see jurisdiction-link-resolver.ts's own doc comment): a user's own
 * row always outranks the global seeded one, never the reverse, regardless of which is newer.
 */
export const jurisdictionRenewalLinks = pgTable(
  "jurisdiction_renewal_links",
  {
    id: text("id").primaryKey(),
    recordType: text("record_type").notNull(),
    jurisdiction: text("jurisdiction").notNull(), // e.g. "US", "US-CA", "US-NY"
    ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    label: text("label").notNull(), // e.g. "U.S. Department of State — Renew or Replace a Passport"
    sourceNote: text("source_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("jurisdiction_renewal_links_lookup_idx").on(t.recordType, t.jurisdiction),
    index("jurisdiction_renewal_links_owner_idx").on(t.ownerUserId),
  ],
);
