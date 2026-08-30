import { pgTable, text, timestamp, integer, jsonb, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { households } from "./household";
import { encryptedText } from "./encrypted-type";

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
    healthDetail: encryptedText("health_detail"),
    /** Set from a real `Retry-After` response header on a 429 — the connector-scan worker's recovery tick
     * won't re-include this connection before this time, even if its flat cooldown window would otherwise
     * allow it. Null when no provider-advertised wait was captured (the flat cooldown alone governs then). */
    retryNotBeforeAt: timestamp("retry_not_before_at", { withTimezone: true }),
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    cursor: encryptedText("cursor"),
    historyDepthDays: integer("history_depth_days"),
    itemsDiscoveredCount: integer("items_discovered_count").notNull().default(0),
    /** Opaque pointer into the encrypted credential vault — the token itself never lives in this table. Null until the OAuth callback completes. */
    credentialRef: text("credential_ref"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  // The recurring connectorScanWorker scan filters on health + disconnectedAt across the whole table every 15 minutes.
  (t) => [index("connections_owner_idx").on(t.ownerUserId), index("connections_health_disconnected_idx").on(t.health, t.disconnectedAt)],
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
    errorDetail: encryptedText("error_detail"),
  },
  (t) => [index("sync_runs_connection_idx").on(t.connectionId)],
);
