import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { HouseholdService } from "./household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };

/** Captures the last email sent, and pulls the raw invite token out of its accept-link URL — mirrors the
 * real accept-invite web page, which reads `?token=` off the emailed link. */
function capturingMailer() {
  let lastText: string | null = null;
  const mailer = { send: async (msg: { text: string }) => { lastText = msg.text; } } as unknown as MailerService;
  return {
    mailer,
    lastToken(): string {
      const token = lastText?.match(/token=([^\s&]+)/)?.[1];
      if (!token) throw new Error("No token found in last sent email");
      return token;
    },
  };
}

/**
 * FAM-001 "later invite/transition path when appropriate" — real-DB coverage for the dependent-profile ->
 * own-account transition: `dependentProfiles.hasOwnAccount`/`linkedUserId` existed already but nothing ever
 * set them (the only prior reference anywhere was a hardcoded test fixture value, not real product logic —
 * see schedule/adult-availability.test.ts). Proves: invite creation, acceptance actually linking the
 * profile and creating a real household membership, an already-linked profile can't be re-invited, and
 * that only an adult household member/owner can start or revoke the transition (not a non-member, and not
 * another dependent-role member).
 */
describe("HouseholdService — dependent account transition (FAM-001)", () => {
  let db: Database;
  let households: HouseholdService;
  let captured: ReturnType<typeof capturingMailer>;

  let ownerUserId: string;
  let adultMemberUserId: string;
  let otherDependentAccountUserId: string; // an already-linked dependent_profile-role member (restricted, not adult)
  let outsiderUserId: string;
  let householdId: string;
  let dependentId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    captured = capturingMailer();
    households = new HouseholdService(db, entitlements, captured.mailer);

    try {
      ownerUserId = generateId("user");
      adultMemberUserId = generateId("user");
      otherDependentAccountUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");

      await db.insert(schema.users).values([
        { id: ownerUserId, email: `dep-trans-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: adultMemberUserId, email: `dep-trans-adult-${adultMemberUserId}@example.com`, displayName: "Adult Member" },
        { id: otherDependentAccountUserId, email: `dep-trans-kid-${otherDependentAccountUserId}@example.com`, displayName: "Linked Kid" },
        { id: outsiderUserId, email: `dep-trans-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Transition Test Household", billingOwnerUserId: ownerUserId });
      // "family" plan → household_members_max = 6 (packages/core/src/entitlements/plans.ts) — the default
      // plan's cap of 1 is already exhausted by owner+adult member alone, before this test ever invites
      // anyone (see household.invite-quota-race.test.ts's identical setup for the same reasoning).
      await db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId: ownerUserId,
        planKey: "family",
        source: "web_stripe",
        effectiveFrom: new Date(Date.now() - 1000),
        effectiveTo: null,
      });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: adultMemberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: otherDependentAccountUserId, role: "dependent_profile", status: "active", joinedAt: new Date() },
      ]);

      dependentId = generateId("dependentProfile");
      await db.insert(schema.dependentProfiles).values({ id: dependentId, householdId, displayName: "Jamie", guardianUserIds: [ownerUserId] });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping dependent-transition tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.householdId, householdId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, ownerUserId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, adultMemberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherDependentAccountUserId));
      await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
    }
  });

  it("rejects a non-member from starting a transition", async () => {
    if (!dbAvailable) return;
    await expect(
      households.inviteDependentTransition(householdId, dependentId, outsiderUserId, { email: "jamie@example.com" }),
    ).rejects.toMatchObject({ response: { code: "NOT_A_MEMBER" } });
  });

  it("rejects a non-adult (dependent_profile role) member from starting a transition", async () => {
    if (!dbAvailable) return;
    await expect(
      households.inviteDependentTransition(householdId, dependentId, otherDependentAccountUserId, { email: "jamie@example.com" }),
    ).rejects.toMatchObject({ response: { code: "INSUFFICIENT_ROLE" } });
  });

  it("lets an adult member start a dependent's transition, and rejects a second invite while one is pending", async () => {
    if (!dbAvailable) return;
    const result = await households.inviteDependentTransition(householdId, dependentId, adultMemberUserId, { email: "jamie@example.com" });
    expect(result.id).toBe(dependentId);

    const [row] = await db.select().from(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dependentId)).limit(1);
    expect(row?.transitionInvitedEmail).toBe("jamie@example.com");
    expect(row?.transitionInviteTokenHash).toBeTruthy();

    await expect(
      households.inviteDependentTransition(householdId, dependentId, ownerUserId, { email: "jamie@example.com" }),
    ).rejects.toMatchObject({ response: { code: "ALREADY_INVITED" } });
  });

  it("rejects accepting with an account whose email doesn't match the invite", async () => {
    if (!dbAvailable) return;
    await expect(households.acceptDependentTransition(captured.lastToken(), outsiderUserId)).rejects.toMatchObject({
      response: { code: "INVITE_EMAIL_MISMATCH" },
    });
  });

  let jamieUserId: string;

  it("peek returns household + dependent info for a still-pending token", async () => {
    if (!dbAvailable) return;
    const peek = await households.getDependentTransitionInviteByToken(captured.lastToken());
    expect(peek.householdId).toBe(householdId);
    expect(peek.dependentDisplayName).toBe("Jamie");
    expect(peek.invitedEmail).toBe("jamie@example.com");
  });

  it("accepting links the dependent profile and creates a real, restricted household membership", async () => {
    if (!dbAvailable) return;
    jamieUserId = generateId("user");
    await db.insert(schema.users).values({ id: jamieUserId, email: "jamie@example.com", displayName: "Jamie" });

    const result = await households.acceptDependentTransition(captured.lastToken(), jamieUserId);
    expect(result.dependentId).toBe(dependentId);
    expect(result.householdId).toBe(householdId);

    const [dependentRow] = await db.select().from(schema.dependentProfiles).where(eq(schema.dependentProfiles.id, dependentId)).limit(1);
    expect(dependentRow?.hasOwnAccount).toBe(true);
    expect(dependentRow?.linkedUserId).toBe(jamieUserId);
    expect(dependentRow?.transitionInviteTokenHash).toBeNull();
    expect(dependentRow?.transitionInviteTokenExpiresAt).toBeNull();

    const [membershipRow] = await db
      .select()
      .from(schema.householdMemberships)
      .where(eq(schema.householdMemberships.id, result.membershipId))
      .limit(1);
    expect(membershipRow?.userId).toBe(jamieUserId);
    expect(membershipRow?.householdId).toBe(householdId);
    expect(membershipRow?.role).toBe("dependent_profile");
    expect(membershipRow?.status).toBe("active");
  });

  it("an already-linked dependent can't be re-invited, and its old token is no longer valid", async () => {
    if (!dbAvailable) return;
    await expect(
      households.inviteDependentTransition(householdId, dependentId, ownerUserId, { email: "jamie@example.com" }),
    ).rejects.toMatchObject({ response: { code: "ALREADY_LINKED" } });

    await expect(households.acceptDependentTransition(captured.lastToken(), jamieUserId)).rejects.toMatchObject({
      response: { code: "INVALID_INVITE_TOKEN" },
    });
  });

  afterAll(async () => {
    if (dbAvailable && jamieUserId) {
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.userId, jamieUserId));
      await db.delete(schema.users).where(eq(schema.users.id, jamieUserId));
    }
  });
});

describe("HouseholdService — dependent transition revoke + expiry", () => {
  let db: Database;
  let households: HouseholdService;
  let captured: ReturnType<typeof capturingMailer>;

  let ownerUserId: string;
  let householdId: string;
  let dependentId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    captured = capturingMailer();
    households = new HouseholdService(db, entitlements, captured.mailer);

    try {
      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `dep-trans-revoke-owner-${ownerUserId}@example.com`, displayName: "Owner" });
      await db.insert(schema.households).values({ id: householdId, name: "Revoke Test Household", billingOwnerUserId: ownerUserId });
      // Same "family" plan bump as the describe block above — the default plan's household_members_max=1
      // is already used up by the owner alone.
      await db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId: ownerUserId,
        planKey: "family",
        source: "web_stripe",
        effectiveFrom: new Date(Date.now() - 1000),
        effectiveTo: null,
      });
      await db.insert(schema.householdMemberships).values({
        id: generateId("membership"),
        householdId,
        userId: ownerUserId,
        role: "household_owner",
        status: "active",
        joinedAt: new Date(),
      });
      dependentId = generateId("dependentProfile");
      await db.insert(schema.dependentProfiles).values({ id: dependentId, householdId, displayName: "Alex", guardianUserIds: [ownerUserId] });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping dependent-transition revoke/expiry tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.dependentProfiles).where(eq(schema.dependentProfiles.householdId, householdId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, ownerUserId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("revoking a pending invite clears its token so it can no longer be accepted, and frees the dependent for a fresh invite", async () => {
    if (!dbAvailable) return;
    await households.inviteDependentTransition(householdId, dependentId, ownerUserId, { email: "alex@example.com" });
    const revokedToken = captured.lastToken();

    await households.revokeDependentTransitionInvite(householdId, dependentId, ownerUserId);

    await expect(households.acceptDependentTransition(revokedToken, ownerUserId)).rejects.toMatchObject({
      response: { code: "INVALID_INVITE_TOKEN" },
    });

    // Re-inviting immediately after a revoke must succeed (no stale ALREADY_INVITED), same as invite()'s
    // own revoke-then-reinvite behavior.
    const reinvite = await households.inviteDependentTransition(householdId, dependentId, ownerUserId, { email: "alex@example.com" });
    expect(reinvite.id).toBe(dependentId);
  });

  it("revoking with no pending invite fails with NOT_PENDING", async () => {
    if (!dbAvailable) return;
    await households.revokeDependentTransitionInvite(householdId, dependentId, ownerUserId);
    await expect(households.revokeDependentTransitionInvite(householdId, dependentId, ownerUserId)).rejects.toMatchObject({
      response: { code: "NOT_PENDING" },
    });
  });

  it("an expired invite token can't be accepted", async () => {
    if (!dbAvailable) return;
    await households.inviteDependentTransition(householdId, dependentId, ownerUserId, { email: "alex@example.com" });
    const expiredToken = captured.lastToken();
    await db
      .update(schema.dependentProfiles)
      .set({ transitionInviteTokenExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.dependentProfiles.id, dependentId));

    await expect(households.acceptDependentTransition(expiredToken, ownerUserId)).rejects.toMatchObject({
      response: { code: "INVALID_INVITE_TOKEN" },
    });
  });
});
