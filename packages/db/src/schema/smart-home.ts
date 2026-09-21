import { pgTable, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { propertyProfiles } from "./assets";
import { encryptedText } from "./encrypted-type";

/**
 * Phase 3 §31 "Smart Home & Connected Devices" (SMART-001/002/003). Spec's own words: "Smart-home
 * integration is a later expansion... Direct integrations require explicit provider capabilities" — every
 * named vendor (Home Assistant, SmartThings, Nest/Google Home, Alexa-compatible services, Ring, Ecobee,
 * Philips Hue) needs its own OAuth app registration or partner API agreement that does not exist in this
 * dev environment. See docs/PHASE3_PENDING_CREDENTIALS.md for exactly what each one would need.
 *
 * This WAS data model only, with zero live connectors. One now exists: Home Assistant, whose rows do reach
 * `status: "connected"` and are presented in the UI as connected, because a user can genuinely connect it.
 *
 * Home Assistant is the exception to the paragraph above for a specific reason rather than a lucky one: it
 * is self-hosted, so the credential belongs to the user and there is no app registration or partner
 * agreement standing between this code and a working connection. The other named vendors still have
 * exactly that standing in their way and still have no adapter — see
 * `services/api/src/modules/smart-home/smart-home-adapter.interface.ts` and
 * docs/PHASE3_PENDING_CREDENTIALS.md.
 *
 * It is also the one that reaches furthest: Home Assistant already speaks to Z-Wave, Zigbee, Matter, Hue,
 * Ecobee, Nest and SmartThings locally. A household running it can surface devices here that this codebase
 * could never integrate with directly, through a connector that needs no permission from anyone.
 */
export const smartConnections = pgTable(
  "smart_connections",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    propertyProfileId: text("property_profile_id").references(() => propertyProfiles.id, { onDelete: "set null" }),
    // "home_assistant" | "smartthings" | "nest" | "alexa" | "ring" | "ecobee" | "philips_hue" | ...
    provider: text("provider").notNull(),
    // Deliberately never defaults to (or is ever set to, by any code in this repo today) "connected" —
    // "not_configured" is the only status a connection can have while no real adapter exists for its
    // provider. A future real adapter is what would introduce "connected"/"error"/etc.
    status: text("status").notNull().default("not_configured"),
    selectedSignalKinds: jsonb("selected_signal_kinds").$type<string[]>().notNull().default([]), // SMART-001 "device-level selection"
    /**
     * For a provider this deployment holds an OAuth client for. Still unused: no such provider is built,
     * because every one of them (SmartThings, Nest, Ring, Ecobee, Hue) needs an app registration or a
     * partner agreement. Kept rather than removed because it is the right home for those when they exist.
     */
    credentialRef: text("credential_ref"), // opaque pointer into CredentialVault, same pattern as connections.credentialRef
    /**
     * For a provider the USER holds the credential for, which is the only kind that can be built here.
     *
     * Home Assistant is self-hosted: the address is the user's own server and the token is a Long-Lived
     * Access Token they generate in their own profile. There is no client secret for this deployment to
     * hold and no application to register, which is exactly why this is the one §31 provider that is
     * buildable rather than partnership-gated.
     *
     * The token cannot live in `connection_credentials` — that table's `connection_id` is a hard foreign
     * key to `connections`, and a smart connection is not one. So it is stored the way `school_sources`
     * already stores a Canvas token: encrypted on the row that owns it.
     */
    apiBaseUrl: text("api_base_url"),
    apiToken: encryptedText("api_token"),
    /** Why a connection is in `error`, in words a person can act on. Null whenever it is not. */
    healthDetail: text("health_detail"),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  (t) => [index("smart_connections_owner_idx").on(t.ownerUserId)],
);

export const smartDevices = pgTable(
  "smart_devices",
  {
    id: text("id").primaryKey(),
    smartConnectionId: text("smart_connection_id")
      .notNull()
      .references(() => smartConnections.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    propertyProfileId: text("property_profile_id").references(() => propertyProfiles.id, { onDelete: "set null" }),
    providerDeviceId: text("provider_device_id").notNull(), // the ID the provider's own API assigns
    label: encryptedText("label").notNull(),
    deviceType: text("device_type").notNull(), // "lock" | "thermostat" | "camera" | "sensor" | "hub" | "other"
    room: text("room"),
    // SMART-001 "Connection settings show exactly which device types/signals are imported" / "device-level
    // selection" — a device only ever counts toward sync once a user has explicitly opted it in.
    isSelected: boolean("is_selected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("smart_devices_connection_idx").on(t.smartConnectionId)],
);

/**
 * SMART-002 "Maintenance/health signals into obligations." `attentionItemId` is the one hook a future
 * real adapter needs: call whatever service files an `attention_items` row (see AttentionService) and
 * record its id here, so a signal and the obligation it produced stay linked and de-duplicated
 * (`dedupeKey` — "dedupe correlates provider event and email" per SMART-001's backend-behavior line).
 */
export const deviceSignals = pgTable(
  "device_signals",
  {
    id: text("id").primaryKey(),
    smartDeviceId: text("smart_device_id")
      .notNull()
      .references(() => smartDevices.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // "battery_low" | "filter_due" | "fault" | "offline" | "leak" | "smoke_co" | "security" | "maintenance_due"
    signalKind: text("signal_kind").notNull(),
    severity: text("severity").notNull().default("info"), // "info" | "warning" | "critical"
    detail: encryptedText("detail"),
    dedupeKey: text("dedupe_key").notNull(),
    attentionItemId: text("attention_item_id"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("device_signals_device_idx").on(t.smartDeviceId), index("device_signals_dedupe_idx").on(t.ownerUserId, t.dedupeKey)],
);
