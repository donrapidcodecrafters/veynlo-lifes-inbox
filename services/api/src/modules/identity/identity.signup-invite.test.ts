// Set BEFORE any import triggers config/env.ts's loadEnv() — that module caches its parsed result in a
// module-level variable the first time it's called, so the flag has to be in process.env from the very
// start of this file's evaluation. Vitest isolates modules per test file by default, so this doesn't leak
// into other test files (identity.email-case.test.ts and identity.signup-flag-off.test.ts both rely on the
// default-false behavior and run with their own fresh module registry).
process.env.SIGNUP_REQUIRES_INVITE = "true";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as argon2 from "argon2";
import { generateId } from "@veynlo/core";
import { hashOpaqueToken } from "@veynlo/core/dist/util/token";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { IdentityService } from "./identity.service";
import { AdminService } from "../admin/admin.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { AnalyticsService } from "../analytics/analytics.service";

/**
 * "Pre-launch private testing distribution" (docs/ROADMAP.md) — real integration tests against real
 * Postgres (same pattern as identity.email-case.test.ts), exercising the actual IdentityService.signUp
 * and AdminService.createSignupInvite/revokeSignupInvite code paths with SIGNUP_REQUIRES_INVITE genuinely
 * on, rather than just asserting on the schema/DTO in isolation.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubAnalytics = { track: async () => {}, trackItemCaught: async () => {} } as unknown as AnalyticsService;

describe("Invite-gated sign-up (SIGNUP_REQUIRES_INVITE=true)", () => {
  let db: Database;
  let identity: IdentityService;
  let admin: AdminService;
  let dbAvailable = true;
  let testAdminId: string;
  const createdUserEmails: string[] = [];
  const runId = Date.now();

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding, stubAnalytics);
    admin = new AdminService(db, stubQueue, identity);
    try {
      await db.select().from(schema.users).limit(1);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping invite-gated sign-up tests — no reachable dev Postgres:", (err as Error).message);
      return;
    }

    testAdminId = generateId("adminUser");
    await db.insert(schema.adminUsers).values({
      id: testAdminId,
      email: `invite-test-admin-${runId}@example.com`,
      displayName: "Invite Test Admin",
      passwordHash: await argon2.hash("irrelevant-not-used-by-these-tests"),
      role: "support",
    });
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const email of createdUserEmails) {
      await db.delete(schema.identityLinks).where(eq(schema.identityLinks.providerSubject, email));
      const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
      if (user) {
        await db.delete(schema.notificationPreferences).where(eq(schema.notificationPreferences.userId, user.id));
        await db.delete(schema.sessions).where(eq(schema.sessions.userId, user.id));
        await db.delete(schema.devices).where(eq(schema.devices.userId, user.id));
      }
      await db.delete(schema.users).where(eq(schema.users.email, email));
    }
    await db.delete(schema.signupInvites).where(eq(schema.signupInvites.createdByAdminId, testAdminId));
    await db.delete(schema.adminUsers).where(eq(schema.adminUsers.id, testAdminId));
  });

  it("creates an invite via AdminService, returning the plaintext code once and persisting only its sha256 hash", async () => {
    if (!dbAvailable) return;
    const result = await admin.createSignupInvite({}, testAdminId);
    expect(result.code).toBeTruthy();
    expect(result.code.length).toBeGreaterThanOrEqual(10);

    const [row] = await db.select().from(schema.signupInvites).where(eq(schema.signupInvites.id, result.id)).limit(1);
    expect(row).toBeDefined();
    expect(row?.codeHash).toBe(hashOpaqueToken(result.code));
    expect(row?.codeHash).not.toBe(result.code);
    expect(row?.redeemedAt).toBeNull();
    expect(row?.createdByAdminId).toBe(testAdminId);
  });

  it("successful redemption marks the invite redeemed and blocks reuse", async () => {
    if (!dbAvailable) return;
    const invite = await admin.createSignupInvite({}, testAdminId);
    const email = `invite-redeem-${runId}@example.com`;
    createdUserEmails.push(email);

    const session = await identity.signUp(
      { email, password: "correcthorsebatterystaple1", displayName: "Redeemer", timezone: "UTC", inviteCode: invite.code },
      { platform: "web" },
    );
    expect(session.token).toBeTruthy();

    const [redeemed] = await db.select().from(schema.signupInvites).where(eq(schema.signupInvites.id, invite.id)).limit(1);
    expect(redeemed?.redeemedAt).not.toBeNull();
    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    expect(redeemed?.redeemedByUserId).toBe(user?.id);

    // Reusing the same code for a second sign-up must be rejected — single-use.
    const secondEmail = `invite-redeem-reuse-${runId}@example.com`;
    await expect(
      identity.signUp(
        { email: secondEmail, password: "anotherpassword123", displayName: "Reuser", timezone: "UTC", inviteCode: invite.code },
        { platform: "web" },
      ),
    ).rejects.toMatchObject({ response: { code: "INVITE_ALREADY_REDEEMED" } });

    const [secondUser] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, secondEmail)).limit(1);
    expect(secondUser).toBeUndefined();
  });

  it("rejects an expired invite", async () => {
    if (!dbAvailable) return;
    const code = `EXPIREDCODE${runId}`;
    const inviteId = generateId("signupInvite");
    await db.insert(schema.signupInvites).values({
      id: inviteId,
      codeHash: hashOpaqueToken(code),
      createdByAdminId: testAdminId,
      expiresAt: new Date(Date.now() - 60_000), // already in the past
    });

    const email = `invite-expired-${runId}@example.com`;
    await expect(
      identity.signUp({ email, password: "correcthorsebatterystaple1", displayName: "Late", timezone: "UTC", inviteCode: code }, { platform: "web" }),
    ).rejects.toMatchObject({ response: { code: "INVITE_EXPIRED" } });

    const [user] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
    expect(user).toBeUndefined();
    await db.delete(schema.signupInvites).where(eq(schema.signupInvites.id, inviteId));
  });

  it("rejects a code redeemed with an email different from the one it's bound to", async () => {
    if (!dbAvailable) return;
    const boundEmail = `invite-bound-${runId}@example.com`;
    const invite = await admin.createSignupInvite({ email: boundEmail }, testAdminId);

    const wrongEmail = `invite-wrong-email-${runId}@example.com`;
    await expect(
      identity.signUp(
        { email: wrongEmail, password: "correcthorsebatterystaple1", displayName: "Wrong", timezone: "UTC", inviteCode: invite.code },
        { platform: "web" },
      ),
    ).rejects.toMatchObject({ response: { code: "INVITE_EMAIL_MISMATCH" } });

    const [wrongUser] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, wrongEmail)).limit(1);
    expect(wrongUser).toBeUndefined();

    // The same code DOES work for the email it's actually bound to.
    createdUserEmails.push(boundEmail);
    const session = await identity.signUp(
      { email: boundEmail, password: "correcthorsebatterystaple1", displayName: "Right", timezone: "UTC", inviteCode: invite.code },
      { platform: "web" },
    );
    expect(session.token).toBeTruthy();
  });

  it("rejects sign-up with no invite code at all when the flag is on", async () => {
    if (!dbAvailable) return;
    const email = `invite-missing-code-${runId}@example.com`;
    await expect(
      identity.signUp({ email, password: "correcthorsebatterystaple1", displayName: "No Code", timezone: "UTC" }, { platform: "web" }),
    ).rejects.toMatchObject({ response: { code: "INVITE_CODE_REQUIRED" } });
  });

  it("revoke blocks redemption, and revoking an already-redeemed invite is rejected", async () => {
    if (!dbAvailable) return;
    const invite = await admin.createSignupInvite({}, testAdminId);
    await admin.revokeSignupInvite(invite.id, testAdminId);

    const email = `invite-revoked-${runId}@example.com`;
    await expect(
      identity.signUp({ email, password: "correcthorsebatterystaple1", displayName: "Revoked", timezone: "UTC", inviteCode: invite.code }, { platform: "web" }),
    ).rejects.toMatchObject({ response: { code: "INVITE_REVOKED" } });

    const redeemedInvite = await admin.createSignupInvite({}, testAdminId);
    const redeemedEmail = `invite-then-revoke-${runId}@example.com`;
    createdUserEmails.push(redeemedEmail);
    await identity.signUp(
      { email: redeemedEmail, password: "correcthorsebatterystaple1", displayName: "Redeemed First", timezone: "UTC", inviteCode: redeemedInvite.code },
      { platform: "web" },
    );
    await expect(admin.revokeSignupInvite(redeemedInvite.id, testAdminId)).rejects.toMatchObject({ response: { code: "ALREADY_REDEEMED" } });
  });
});
