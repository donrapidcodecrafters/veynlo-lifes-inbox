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
 * This file is DATA MODEL ONLY, with zero live connectors — the same "reserve the shape before the
 * feature exists" move `packages/core/src/util/ids.ts` already made once for `lists` (table/id prefixes
 * committed ahead of the feature being built). Nothing anywhere in this codebase writes a `smartConnections`
 * row with `status: "connected"`, and no UI presents one as available — see `services/api/src/modules/
 * smart-home/smart-home-adapter.interface.ts` for the adapter shape a future real connector would
 * implement, and the Connections page for the "coming soon" copy this scaffolding backs.
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
    credentialRef: text("credential_ref"), // opaque pointer into CredentialVault, same pattern as connections.credentialRef
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
