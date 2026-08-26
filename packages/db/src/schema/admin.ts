import { pgTable, text, timestamp, pgEnum } from "drizzle-orm/pg-core";

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
