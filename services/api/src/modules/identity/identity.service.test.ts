import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { IdentityService } from "./identity.service";

/**
 * verifyPassword() is the shared step-up reauth check now used by both account deletion and requesting a
 * full data export (data-export.controller.ts) — previously data-export had no reauth at all beyond the
 * standing session AuthGuard. Real DB-backed proof it actually gates both account shapes correctly.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const identity = new IdentityService(db, {} as never, {} as never);

const passwordUserId = generateId("user");
const oauthOnlyUserId = generateId("user");
const REAL_PASSWORD = "correct-horse-battery-staple";

beforeAll(async () => {
  const passwordHash = await argon2.hash(REAL_PASSWORD);
  await db.insert(schema.users).values([
    { id: passwordUserId, displayName: "Password user", passwordHash },
    { id: oauthOnlyUserId, displayName: "OAuth-only user", passwordHash: null },
  ]);
});

afterAll(async () => {
  await db.delete(schema.users).where(inArray(schema.users.id, [passwordUserId, oauthOnlyUserId]));
});

describe("IdentityService.verifyPassword", () => {
  it("passes for a password-based account when the real password is given", async () => {
    await expect(identity.verifyPassword(passwordUserId, REAL_PASSWORD)).resolves.toBeUndefined();
  });

  it("rejects a password-based account given the wrong password", async () => {
    await expect(identity.verifyPassword(passwordUserId, "wrong-password")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("rejects a password-based account given no password at all", async () => {
    await expect(identity.verifyPassword(passwordUserId, undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("passes for an OAuth-only account (no passwordHash) regardless of what's given", async () => {
    await expect(identity.verifyPassword(oauthOnlyUserId, undefined)).resolves.toBeUndefined();
    await expect(identity.verifyPassword(oauthOnlyUserId, "anything")).resolves.toBeUndefined();
  });

  it("rejects a nonexistent user", async () => {
    await expect(identity.verifyPassword(generateId("user"), REAL_PASSWORD)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
