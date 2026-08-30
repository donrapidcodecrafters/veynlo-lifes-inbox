import { describe, expect, it, vi, beforeAll, afterAll } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { HouseholdService } from "./household.service";

/**
 * §HH-001 "transfer household ownership" / "resend, revoke... invite" — previously nonexistent despite
 * two real, blocking error paths (leave(), IdentityService.requestDeletion) telling the owner to transfer
 * first, and an ALREADY_INVITED check that (before this pass) matched ANY row regardless of status,
 * permanently blocking re-invites after a revoke. Real DB-backed proof both now actually work.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const mailer = { send: vi.fn(async () => undefined) };
const billing = { getCapability: vi.fn(async () => null) }; // null = unlimited, skips the quota check
const households = new HouseholdService(db, mailer as never, billing as never);

const ownerId = generateId("user");
const adultMemberId = generateId("user");
const strangerId = generateId("user");
const householdId = generateId("household");

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: adultMemberId, displayName: "Adult Member" },
    { id: strangerId, displayName: "Stranger" },
  ]);
  await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerId });
  await db.insert(schema.householdMemberships).values([
    { id: generateId("membership"), householdId, userId: ownerId, role: "household_owner", status: "active", joinedAt: new Date() },
    { id: generateId("membership"), householdId, userId: adultMemberId, role: "adult_member", status: "active", joinedAt: new Date() },
  ]);
});

afterAll(async () => {
  await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
  await db.delete(schema.households).where(eq(schema.households.id, householdId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, adultMemberId, strangerId]));
});

describe("HouseholdService.transferOwnership", () => {
  it("refuses when the caller isn't the current owner", async () => {
    await expect(households.transferOwnership(householdId, adultMemberId, ownerId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses transferring to a nonexistent/non-member user", async () => {
    await expect(households.transferOwnership(householdId, ownerId, strangerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses transferring to yourself", async () => {
    await expect(households.transferOwnership(householdId, ownerId, ownerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the real owner can transfer ownership to a real adult member, and the transfer genuinely swaps roles", async () => {
    await households.transferOwnership(householdId, ownerId, adultMemberId);

    const [ownerRow] = await db
      .select({ role: schema.householdMemberships.role })
      .from(schema.householdMemberships)
      .where(eq(schema.householdMemberships.userId, ownerId));
    const [newOwnerRow] = await db
      .select({ role: schema.householdMemberships.role })
      .from(schema.householdMemberships)
      .where(eq(schema.householdMemberships.userId, adultMemberId));

    expect(ownerRow?.role).toBe("adult_member"); // demoted
    expect(newOwnerRow?.role).toBe("household_owner"); // promoted

    // households.billingOwnerUserId must NOT move -- that's a separate, deliberately independent concern
    const [household] = await db.select({ billingOwnerUserId: schema.households.billingOwnerUserId }).from(schema.households).where(eq(schema.households.id, householdId));
    expect(household?.billingOwnerUserId).toBe(ownerId);
  });

  it("the former owner (now a plain adult member) can no longer transfer ownership themselves", async () => {
    await expect(households.transferOwnership(householdId, ownerId, adultMemberId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("HouseholdService.revokeInvite / invite re-send after revoke", () => {
  const revokeOwnerId = generateId("user");
  const revokeHouseholdId = generateId("household");
  const inviteEmail = "typo-victim@example.com";

  beforeAll(async () => {
    await db.insert(schema.users).values({ id: revokeOwnerId, displayName: "Revoke Test Owner" });
    await db.insert(schema.households).values({ id: revokeHouseholdId, name: "Revoke Test Household", billingOwnerUserId: revokeOwnerId });
    await db.insert(schema.householdMemberships).values({
      id: generateId("membership"),
      householdId: revokeHouseholdId,
      userId: revokeOwnerId,
      role: "household_owner",
      status: "active",
      joinedAt: new Date(),
    });
  });

  afterAll(async () => {
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, revokeHouseholdId));
    await db.delete(schema.households).where(eq(schema.households.id, revokeHouseholdId));
    await db.delete(schema.users).where(eq(schema.users.id, revokeOwnerId));
  });

  it("a revoked invite genuinely frees up re-inviting the same email (previously blocked forever)", async () => {
    const { id: firstInviteId } = await households.invite(revokeHouseholdId, revokeOwnerId, { email: inviteEmail });

    await expect(households.invite(revokeHouseholdId, revokeOwnerId, { email: inviteEmail })).rejects.toBeInstanceOf(BadRequestException);

    await households.revokeInvite(revokeHouseholdId, firstInviteId, revokeOwnerId);
    const [revoked] = await db.select({ status: schema.householdMemberships.status }).from(schema.householdMemberships).where(eq(schema.householdMemberships.id, firstInviteId));
    expect(revoked?.status).toBe("removed");

    // the exact bug this fixes: re-inviting the same email used to be blocked forever, even after revoke
    const { id: secondInviteId } = await households.invite(revokeHouseholdId, revokeOwnerId, { email: inviteEmail });
    expect(secondInviteId).not.toBe(firstInviteId);
  });

  it("cannot revoke an already-accepted (active) membership via this endpoint", async () => {
    const [ownerMembership] = await db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(eq(schema.householdMemberships.userId, revokeOwnerId));
    await expect(households.revokeInvite(revokeHouseholdId, ownerMembership!.id, revokeOwnerId)).rejects.toBeInstanceOf(BadRequestException);
  });
});
