import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import type { TemporalValue } from "@veynlo/core";
import { users } from "./identity";
import { households } from "./household";
import { visibilityEnum } from "./common";
import { encryptedText } from "./encrypted-type";

/**
 * §27 "Health Logistics (Non-Diagnostic)" (HLTH-001). Logistics-only by construction — there is
 * deliberately no field here for a symptom, diagnosis, reason-for-visit, or clinical note; only
 * who/where/when/what-document, mirroring how `calendarEvents` never carries a "why" either. See
 * `IngestionService.extractHealthAppointment`'s own doc comment for how the AI-extraction side of this
 * boundary is enforced, and `HealthLogisticsService`'s doc comment for the access-control model.
 *
 * `visibility` defaults to "private" (unlike `calendarEvents`, which also defaults "private" but is read
 * via a helper that ORs in plain household membership) — for this table plain membership is NEVER OR'd in
 * by `HealthLogisticsService`'s read paths; only the owner, an explicit `resourceGrants` row (via
 * SharingService, resourceType "health_appointment"), or an explicit "health:read" caregiver delegation can
 * see another household member's row. That's the concrete meaning of the chapter's "private by default;
 * strong access controls" line — household membership alone must not grant visibility the way it does for
 * a shared grocery list.
 */
export const healthAppointments = pgTable(
  "health_appointments",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    visibility: visibilityEnum("visibility").notNull().default("private"),
    providerName: encryptedText("provider_name"),
    // A plain scheduling category ("dental", "vision", "primary care"), never a reason for visit or
    // diagnosis — see HealthAppointmentExtractionSchema's own doc comment on why this field can't carry
    // clinical content even from a well-behaved extractor.
    appointmentType: encryptedText("appointment_type"),
    dateTime: jsonb("date_time").$type<TemporalValue>().notNull(),
    dateTimeSort: timestamp("date_time_sort", { withTimezone: true }),
    location: encryptedText("location"),
    // HLTH-001 "prep instructions only when sourced" — null unless literally stated in the source
    // (email/manual entry); never a generic/inferred instruction for the appointment type.
    prepInstructions: encryptedText("prep_instructions"),
    status: text("status").notNull().default("confirmed"),
    source: text("source").notNull().default("manual"),
    sourceEventId: text("source_event_id"),
    confidenceBand: text("confidence_band"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("health_appointments_owner_idx").on(t.ownerUserId, t.dateTimeSort)],
);
