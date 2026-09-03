import { pgTable, text, timestamp, boolean, pgEnum, jsonb, index } from "drizzle-orm/pg-core";
import { encryptedText } from "./encrypted-type";

export const userStatusEnum = pgEnum("user_status", ["active", "suspended", "deletion_pending", "deleted"]);
export const themePreferenceEnum = pgEnum("theme_preference", ["system", "light", "dark"]);

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  // Stays plaintext: login looks users up by exact email match (`WHERE email = ?`), and AES-GCM is
  // non-deterministic (a fresh random IV every encryption), so an encrypted column can't support equality
  // lookups without a separate deterministic/blind-index scheme — not implemented here (see SECURITY.md).
  email: text("email").unique(),
  displayName: encryptedText("display_name").notNull(),
  locale: text("locale").notNull().default("en-US"),
  timezone: text("timezone").notNull().default("UTC"),
  currency: text("currency").notNull().default("USD"),
  status: userStatusEnum("status").notNull().default("active"),
  themePreference: themePreferenceEnum("theme_preference").notNull().default("system"),
  passwordHash: text("password_hash"),
  // Set once, from the `checkout.session.completed` webhook's `session.customer` — needed for the Stripe
  // Customer Portal (billingPortal.sessions.create requires a customer id, not just a subscription id).
  // Nothing wrote this before the billing UI existed, since the webhook never had a reason to persist it.
  stripeCustomerId: text("stripe_customer_id"),
  // PRIV-001 "privacy/consent center" — real, checked opt-out: IngestionService.classifyAndExtract reads
  // this before ever calling the AI classifier/extractor, not just a cosmetic settings toggle. Off means
  // every captured item is filed unprocessed (same "nothing extracted" shape as ANTHROPIC_API_KEY being
  // unset) rather than silently still running AI behind a switch that looked like it worked.
  aiProcessingEnabled: boolean("ai_processing_enabled").notNull().default(true),
  // CAP-005 "forward-to-Life-Inbox address" (§12.1/§52.1) — an opaque routing token, not the userId
  // itself, specifically so it can be rotated (a leaked/spammed alias can be replaced without disturbing
  // the account) without exposing the internal id in an externally-forwarded address. Stays plaintext:
  // the inbound webhook must look a sender up by exact match on this column, and AES-GCM's non-
  // deterministic IV rules out an encrypted column for equality lookups (same reasoning as `email` above).
  inboundEmailAlias: text("inbound_email_alias").unique(),
  // PRIV-002 "grace period if used" — set the moment `status` becomes "deletion_pending"
  // (IdentityService.requestDeletion), cleared back to null on cancellation or once deletion actually
  // completes. The account-deletion worker's job itself is delayed to fire at (approximately) this same
  // timestamp — see QueueProducerService.enqueueAccountDeletion's `delayMs` — so this column is the
  // user-visible half of the same fact the queue is independently tracking, not the enforcement mechanism.
  scheduledDeletionAt: timestamp("scheduled_deletion_at", { withTimezone: true }),
  // §35 SHARE-006 legacy-release inactivity trigger — the real "has this owner actually used the app
  // recently" signal LegacyReleaseService.scanInactivity reads, distinct from `sessions.lastSeenAt` (which
  // is per-session/per-device) since inactivity here is a whole-ACCOUNT question and a config's
  // `inactivityThresholdDays` shouldn't reset just because one particular device's session happens to be
  // fresh while every other access path has gone quiet. Updated at every real authenticated touchpoint —
  // sign-in (IdentityService.issueSession), refresh (IdentityService.refreshSession), and ordinary
  // request traffic (AuthGuard, throttled — see its own doc comment) — never just at account creation.
  // Defaults to now() so an existing/newly-created user is never retroactively treated as already inactive.
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

/** Maps external OAuth/OIDC subjects to one internal user (§AUTH-001). */
export const identityLinks = pgTable(
  "identity_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(), // "google" | "microsoft" | "apple" | "passkey" | "email"
    // Stays plaintext: this table's whole purpose is an equality lookup on (provider, providerSubject)
    // during OAuth sign-in (see the index below) — same non-deterministic-encryption constraint as
    // users.email above.
    providerSubject: text("provider_subject").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("identity_links_provider_subject_idx").on(t.provider, t.providerSubject)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    deviceId: text("device_id").references(() => devices.id, { onDelete: "set null" }),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    // Kept for exactly one rotation so a replayed (already-rotated-away) refresh token can be told apart
    // from a merely-invalid one — see IdentityService.refreshSession's reuse-detection comment. Null for
    // sessions issued before this column existed, which simply can't use /v1/auth/refresh (same graceful
    // "not available yet" posture as every other optional capability in this app, not an error state).
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    // Absolute cap on the refresh chain, set once at sign-in and never extended by a later refresh — an
    // actively-refreshed session still eventually forces real re-authentication rather than staying alive
    // forever on rotation alone.
    refreshExpiresAt: timestamp("refresh_expires_at", { withTimezone: true }),
    riskFlags: jsonb("risk_flags").$type<string[]>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * §28.9 "account recovery must not be weaker than normal authentication" — this codebase implements a
 * local password database (a deliberate architectural deviation from the blueprint's Cognito-only
 * target, tracked in docs/DECISIONS.md), which means it also has to implement its own recovery flow;
 * before this table existed, a user who forgot their password had no way back into their account at all.
 * One-time, high-entropy, short-lived, single-use, stored hashed — same shape as `share_links.token_hash`
 * — never a security question.
 */
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("password_reset_tokens_user_idx").on(t.userId)],
);

export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(), // "ios" | "android" | "web" | "macos" | "windows"
  displayName: encryptedText("display_name"),
  pushToken: encryptedText("push_token"),
  biometricLockEnabled: boolean("biometric_lock_enabled").notNull().default(false),
  trusted: boolean("trusted").notNull().default(false),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * AUTH-001 "create passkey" — a WebAuthn public-key credential, the phishing-resistant sign-in method the
 * spec names alongside Apple/Google/Microsoft OAuth. Deliberately extends this table (already present in
 * the schema, never previously written to by any code — confirmed by grepping every reference before this
 * pass) rather than introducing a parallel `passkey_credentials` table, since the columns below are exactly
 * what a real `@simplewebauthn/server`-backed registration/authentication ceremony needs and nothing this
 * table already had conflicts with that shape.
 */
export const passkeys = pgTable(
  "passkeys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(), // lookup key during WebAuthn assertion — stays plaintext
    publicKey: text("public_key").notNull(), // a WebAuthn *public* key — not confidential by design, nothing to encrypt
    // Base64url-encoded COSE public key bytes are stored in `publicKey` above; `counter` is the signature
    // counter @simplewebauthn/server returns as a `number`, stored as text purely so a very large counter
    // never risks floating-point precision loss the way a `bigint`-unsafe JS number read back from an
    // `integer` column could — parsed back to a number at read time (JS's Number.MAX_SAFE_INTEGER is far
    // beyond any real authenticator's counter range in practice).
    counter: text("counter").notNull().default("0"),
    // WebAuthn `AuthenticatorTransport[]` (e.g. ["internal"], ["hybrid","internal"]) — passed back as
    // `allowCredentials[].transports` on a later authentication ceremony as a hint to the browser about how
    // it might reach this credential; optional per the spec, so an empty array (never null) when the
    // registration response didn't report any.
    transports: jsonb("transports").$type<string[]>().notNull().default([]),
    // "singleDevice" | "multiDevice" (@simplewebauthn's `credentialDeviceType`) — surfaced in the "Manage
    // your passkeys" UI so a user can tell a device-bound security key apart from a synced/cloud passkey.
    deviceType: text("device_type"),
    // Whether the authenticator reported this credential as backed up (synced) at registration time — a
    // read-only informational flag alongside deviceType, never used as an authorization decision.
    backedUp: boolean("backed_up"),
    // A user-facing nickname for this credential's row in "Manage your passkeys" (e.g. "Chrome on MacBook",
    // derived client-side from the browser/OS at registration time, editable later) — not sensitive, so
    // plain text rather than encryptedText, same reasoning as devices.platform above.
    label: text("label"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  (t) => [index("passkeys_user_idx").on(t.userId)],
);
