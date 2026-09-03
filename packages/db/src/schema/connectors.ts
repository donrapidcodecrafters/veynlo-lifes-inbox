import { pgTable, text, timestamp, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
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
    lastSuccessfulSyncAt: timestamp("last_successful_sync_at", { withTimezone: true }),
    cursor: encryptedText("cursor"),
    historyDepthDays: integer("history_depth_days"),
    itemsDiscoveredCount: integer("items_discovered_count").notNull().default(0),
    /** Opaque pointer into the encrypted credential vault — the token itself never lives in this table. Null until the OAuth callback completes. */
    credentialRef: text("credential_ref"),
    // CAL-001 "write-back capability... requested only when user enables write-back" — OFF by default for
    // every connection, calendar or not (only google_calendar/microsoft_calendar connections ever act on
    // it; ConnectorsService.setWriteBack refuses to flip this true unless `scopes` already contains the
    // provider's write scope, which today means the user has to reconnect once to grant it — see
    // google-calendar.adapter.ts/microsoft-calendar.adapter.ts's `authorizationUrl(writeBack: true)`).
    writeBackEnabled: boolean("write_back_enabled").notNull().default(false),
    // PRIV-001 "per-source AI-processing toggle" — nullable override on top of `users.aiProcessingEnabled`:
    // null means "inherit whatever the account-level toggle currently says" (the only value every existing
    // connection has, and the only value a brand-new connection gets, so this is purely additive — nothing
    // that worked before changes for anyone who never touches the per-connection switch). true/false is an
    // explicit override for THIS connection only, taking precedence over the global setting either
    // direction (a user can turn AI OFF globally but back ON for one trusted connection, or vice versa).
    // Checked in IngestionService.classifyAndExtract right alongside the existing global-toggle gate.
    aiProcessingEnabled: boolean("ai_processing_enabled"),
    // PRIV-001 "pause a connection's processing without fully disconnecting it" — distinct from
    // `disconnectedAt`: a paused connection keeps its credential, its already-synced data, and its health
    // status, it just stops being picked up by the recurring incremental-sync scan (see worker-main.ts's
    // connectorScanWorker) until resumed. `pausedAt` is informational (surfaced in the UI), not itself
    // load-bearing — `paused` is the only column any query actually filters on.
    paused: boolean("paused").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    disconnectedAt: timestamp("disconnected_at", { withTimezone: true }),
  },
  (t) => [index("connections_owner_idx").on(t.ownerUserId)],
);

/**
 * PRIV-001 "exclude a specific sender from a connection's processing" — a minimal per-connection
 * allow/deny mechanism. No parallel `sender_rules` table existed anywhere in the codebase at the time this
 * was built (confirmed via a full-repo grep before adding this), so this is a purpose-built table rather
 * than an extension of one. `excludedSenderDomain` is matched against the lowercased domain half of a
 * source event's `fromAddress` (see IngestionService.classifyAndExtract) — domain-level, not full-address,
 * since that's the granularity the UI asks for ("exclude this sender") and matches how most senders that
 * are worth excluding (a mailing list, a specific merchant) actually vary their local-part per message.
 */
export const connectionExclusions = pgTable(
  "connection_exclusions",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    excludedSenderDomain: text("excluded_sender_domain").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("connection_exclusions_connection_idx").on(t.connectionId)],
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

/**
 * §43 CONN-001 "Webhook/push + reconciliation" — one row per active provider push subscription, the
 * lookup table `webhooks.controller.ts`'s three receivers (`/v1/webhooks/gmail`|`microsoft`|`plaid`) use to
 * map an incoming, verified push notification back to the Veynlo `connections` row it's about, since the
 * notification itself never carries our own `connectionId`.
 */
export const webhookSubscriptions = pgTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    // "gmail" | "microsoft" | "plaid" — the webhook AUTHENTICATION scheme this row uses (see
    // webhook-verification.ts), not necessarily identical to `connections.provider`: every Microsoft-family
    // connection (outlook/microsoft_calendar/onedrive/microsoft_todo) authenticates its Graph subscription
    // the same clientState way, so they all share this one value here.
    provider: text("provider").notNull(),
    // SHA-256 hash (see webhook-verification.ts's hashWebhookSecret) of the app-generated `clientState`
    // secret Microsoft Graph echoes back on every notification — the raw secret is never persisted. Null
    // for Gmail/Plaid, whose authenticity check is a provider-signed JWT instead (nothing here to hash).
    channelSecretHash: text("channel_secret_hash"),
    // The provider's own identifier for whatever this push subscription is about — what an incoming
    // notification actually carries to correlate against, since it never carries our own `connectionId`:
    // Gmail push payloads carry the mailbox's `emailAddress`; Microsoft Graph notifications carry the
    // `subscriptionId` Graph assigned when the subscription was created; Plaid webhooks carry `item_id`.
    externalId: text("external_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    renewedAt: timestamp("renewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_subscriptions_provider_external_idx").on(t.provider, t.externalId)],
);

/**
 * §42.5 "Historical backfill: chunked, resumable, rate-limited, user-visible progress" — the actual
 * resumability record for a connector's initial backfill, one row per attempt. Previously defined but with
 * zero readers/writers anywhere: `connections.cursor`/`itemsDiscoveredCount` were only ever written ONCE,
 * after an entire multi-page backfill finished, so a job that died mid-backfill (a process restart, an OOM,
 * a crash) had BullMQ's retry re-run `initialSync` from page 1 every time — see
 * sync-run.util.ts's `findOrCreateBackfillRun`, the one place that reads/writes this table (used by
 * gmail.adapter.ts and outlook.adapter.ts's `initialSync`).
 */
export const syncRuns = pgTable(
  "sync_runs",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "initial_backfill" | "incremental" | "reconciliation"
    // "running" | "completed" | "failed" — a failed (or hard-killed, never-reached-the-catch-block) run
    // stays resumable: findOrCreateBackfillRun picks up any non-"completed" row regardless of which of
    // these two it's in, since a hard process kill mid-page never gets the chance to write "failed" at all.
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    itemsProcessed: integer("items_processed").notNull().default(0),
    // How many pages of this backfill have fully completed — the "pages-completed" half of §42.5's own
    // "tracking status/pages-completed/last-checkpoint" resumability record, and a natural place to expose
    // backfill progress beyond a raw item count.
    pagesCompleted: integer("pages_completed").notNull().default(0),
    // The provider's own page-token/continuation-link as of the last successfully completed page (Gmail:
    // `messages.list`'s `nextPageToken`; Outlook: the Graph `@odata.nextLink` URL) — persisted after EACH
    // page, not just at the end, so a resumed run picks up from here instead of restarting. Encrypted like
    // `connections.cursor` — an opaque provider token, not sensitive content, but consistent with this
    // table's existing `errorDetail` treatment.
    checkpoint: encryptedText("checkpoint"),
    errorDetail: encryptedText("error_detail"),
  },
  (t) => [index("sync_runs_connection_idx").on(t.connectionId)],
);
