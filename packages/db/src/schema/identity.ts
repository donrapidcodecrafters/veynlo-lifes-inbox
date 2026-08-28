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
    riskFlags: jsonb("risk_flags").$type<string[]>().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
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

export const passkeys = pgTable("passkeys", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull().unique(), // lookup key during WebAuthn assertion — stays plaintext
  publicKey: text("public_key").notNull(), // a WebAuthn *public* key — not confidential by design, nothing to encrypt
  counter: text("counter").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
