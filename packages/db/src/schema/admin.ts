import { pgTable, text, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { users } from "./identity";

/**
 * §3.1 "Support agent" is a distinct principal type — a separate table
 * (not a role flag on `users`) keeps operator accounts structurally
 * unable to log into the consumer product, and keeps the consumer
 * `users` table free of any privileged-access concept (§45 "least
 * privilege... support tools hide private content by default").
 */
export const adminRoleEnum = pgEnum("admin_role", ["support", "superadmin"]);

export const adminUsers = pgTable("admin_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  displayName: text("display_name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: adminRoleEnum("role").notNull().default("support"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const adminSessions = pgTable("admin_sessions", {
  id: text("id").primaryKey(),
  adminUserId: text("admin_user_id")
    .notNull()
    .references(() => adminUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/**
 * "Pre-launch private testing distribution" (docs/ROADMAP.md) — gates sign-up behind an admin-issued
 * invite code when `SIGNUP_REQUIRES_INVITE` is on. Hashed at rest via the same sha256(raw) scheme as
 * `shareLinks.tokenHash` (documents.service.ts's share-link creation) — the plaintext code is only ever
 * returned once, at creation time, never persisted or shown again. `email` is nullable: null means any
 * email can redeem the code, a set value binds it to one specific (normalized) address. `expiresAt` and
 * `revokedAt` are deliberately separate fields, matching `shareLinks`' own split of the two — an invite
 * can lapse on its own schedule (expiresAt) independently of an admin actively pulling it (revokedAt).
 */
export const signupInvites = pgTable("signup_invites", {
  id: text("id").primaryKey(),
  codeHash: text("code_hash").notNull().unique(),
  email: text("email"),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  // set null, not cascade: redeeming the invite is what matters for the audit trail — the invite record
  // (and the fact that it was redeemed) should outlive the redeeming user's account being later deleted,
  // same reasoning as automation.ts's approvedByUserId.
  redeemedByUserId: text("redeemed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  // Admin accounts are only ever revoked, never hard-deleted (see AdminService.revokeAdmin) — cascade
  // mirrors shareLinks.createdByUserId's reasoning even though this path is largely theoretical today.
  createdByAdminId: text("created_by_admin_id")
    .notNull()
    .references(() => adminUsers.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
