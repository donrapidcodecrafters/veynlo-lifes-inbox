import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";

export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    householdId: text("household_id").references(() => households.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    feasibilityClass: text("feasibility_class").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    enabledCategories: jsonb("enabled_categories").$type<string[]>().notNull().default([]),
    health: text("health").notNull().default("initializing"),
    healthDetail: text("health_detail"),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    cursor: text("cursor"),
    historyDepthDays: integer("history_depth_days"),
    itemsDiscoveredCount: integer("items_discovered_count").notNull().default(0),
    /** Opaque pointer into the encrypted credential vault — the token itself never lives in this table. Null until the OAuth callback completes. */
    credentialRef: text("credential_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  (t) => [index("connections_owner_idx").on(t.ownerUserId)],
);

/**
 * Encrypted OAuth/API credentials live in a dedicated table separated from
 * `connections`, application-layer-encrypted (KMS envelope), never joined
 * into general reporting/analytics queries (§45.1, Appendix I).
 */
export const connectionCredentials = pgTable("connection_credentials", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  encryptedPayload: text("encrypted_payload").notNull(),
  encryptionKeyId: text("encryption_key_id").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

export const webhookSubscriptions = pgTable("webhook_subscriptions", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .references(() => connections.id, { onDelete: "cascade" }),
  channelSecretHash: text("channel_secret_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  renewedAt: timestamp("renewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "initial_backfill" | "incremental" | "reconciliation"
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    itemsProcessed: integer("items_processed").notNull().default(0),
    errorDetail: text("error_detail"),
  },
  (t) => [index("sync_runs_connection_idx").on(t.connectionId)],
);
