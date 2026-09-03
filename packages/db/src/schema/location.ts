import { pgTable, text, timestamp, integer, boolean, jsonb, doublePrecision, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedText } from "./encrypted-type";

/**
 * Phase 3 §30 "Location & Context" (LOC-003/004/005 buildable subset; LOC-002's "arrive/leave reminders"
 * example is what `contextRules` exists to express). §30.1's own governing principle: "prefer OS
 * geofencing/significant-change mechanisms over continuous background tracking... server stores rule
 * geometry minimally." Concretely that means:
 *   - `places` stores a durable point (lat/lng), not a movement trail.
 *   - `geofences` stores a radius + trigger kind — the OS (`Location.startGeofencingAsync` on mobile)
 *     owns the actual monitoring; this table is metadata plus the OS-issued region identifier.
 *   - `geofenceEvents` records only DISCRETE trigger firings (which geofence, arrival or departure,
 *     when) — never a raw coordinate, never a continuous position stream. This is the concrete mechanism
 *     behind LOC-006 ("do not create a passive long-term movement diary by default"): there is no table
 *     anywhere in this schema that stores a user's location on any cadence other than "a geofence they
 *     themselves created just fired." See LocationService's own doc comment for the same guarantee
 *     re-verified at the service layer.
 *   - `locationPermissionState` is one row per user (upserted, not appended) recording which OS
 *     permission tiers are currently granted — a status flag, not a log.
 *   - `travelEstimates` (LOC-004) stores a computed estimate between two saved places, not a real-time
 *     tracked route. See `packages/core/src/util/geo.ts` for why this is a haversine (straight-line)
 *     estimate rather than a real traffic-aware one — no maps/distance-matrix provider is configured in
 *     this environment.
 */
export const places = pgTable(
  "places",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    label: encryptedText("label").notNull(), // e.g. "Home", "Mom's house", "Costco"
    address: encryptedText("address"),
    // Nullable: LOC-005 extraction of a plain address string (no maps-link coordinates, no geocoding
    // provider configured) yields an address with no lat/lng yet — the user can fill coordinates in
    // manually later. A geofence cannot be created on a place until both are set (enforced in
    // LocationService.createGeofence, not at the DB level).
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    // "manual" | "extracted_maps_link" | "extracted_address" — see place-extraction.ts (LOC-005).
    source: text("source").notNull().default("manual"),
    sourceEventId: text("source_event_id"), // the inbox/capture item this was extracted from, if any
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("places_owner_idx").on(t.ownerUserId)],
);

export const geofences = pgTable(
  "geofences",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    placeId: text("place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    radiusMeters: integer("radius_meters").notNull().default(150),
    // "arrival" | "departure" | "both"
    triggerKind: text("trigger_kind").notNull().default("arrival"),
    // The identifier `Location.startGeofencingAsync` registers this region under on-device — needed so a
    // later `stopGeofencingAsync`/re-registration call (permission re-grant, radius edit) can address the
    // right OS-level region. Null until the mobile app has actually registered it.
    nativeIdentifier: text("native_identifier"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("geofences_owner_idx").on(t.ownerUserId), index("geofences_place_idx").on(t.placeId)],
);

export const contextRules = pgTable(
  "context_rules",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    geofenceId: text("geofence_id")
      .notNull()
      .references(() => geofences.id, { onDelete: "cascade" }),
    // "remind" (LOC-002 example: "when I get home, check sprinkler") | "resurface_saved_item" (LOC-003).
    actionKind: text("action_kind").notNull().default("remind"),
    actionTitle: encryptedText("action_title").notNull(),
    // e.g. { listId } for resurface_saved_item — deliberately loose, this is a Phase-3-scale action set.
    actionPayload: jsonb("action_payload").$type<Record<string, unknown>>().notNull().default({}),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("context_rules_owner_idx").on(t.ownerUserId), index("context_rules_geofence_idx").on(t.geofenceId)],
);

/**
 * A discrete trigger EVENT, not a location log — see this file's top-level doc comment (LOC-006). Holds
 * no coordinates at all, only which geofence fired, in which direction, and when.
 */
export const geofenceEvents = pgTable(
  "geofence_events",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    geofenceId: text("geofence_id")
      .notNull()
      .references(() => geofences.id, { onDelete: "cascade" }),
    triggerKind: text("trigger_kind").notNull(), // "arrival" | "departure"
    contextRuleFired: boolean("context_rule_fired").notNull().default(false),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("geofence_events_owner_idx").on(t.ownerUserId, t.occurredAt)],
);

/**
 * One row per user (upserted on every permission-state report from the mobile app), never appended to on
 * a schedule — this is a status flag, not telemetry history. §30.1/LOC-001 "Separate foreground/
 * background/precise consent."
 */
export const locationPermissionState = pgTable("location_permission_state", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  foregroundStatus: text("foreground_status").notNull().default("undetermined"), // "granted" | "denied" | "undetermined"
  backgroundStatus: text("background_status").notNull().default("undetermined"),
  precision: text("precision").notNull().default("unknown"), // "precise" | "approximate" | "unknown"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * LOC-004. See `packages/core/src/util/geo.ts` for the haversine-estimate method and its mandatory
 * uncertainty disclosure — `uncertaintyNote` is stored alongside the number specifically so no reader of
 * this table can present the estimate without the caveat that shipped with it.
 */
export const travelEstimates = pgTable(
  "travel_estimates",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    originPlaceId: text("origin_place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    destinationPlaceId: text("destination_place_id")
      .notNull()
      .references(() => places.id, { onDelete: "cascade" }),
    distanceMeters: doublePrecision("distance_meters").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    method: text("method").notNull().default("haversine_rough_estimate"),
    uncertaintyNote: text("uncertainty_note").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("travel_estimates_owner_idx").on(t.ownerUserId)],
);
