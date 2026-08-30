import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { HouseholdService } from "./household.service";

/**
 * §HH-001 "transfer household ownership" — previously nonexistent despite two real, blocking error paths
 * (leave(), IdentityService.requestDeletion) telling the owner to do exactly this first. Real DB-backed
 * proof the new transferOwnership mutation actually works, validates its input, and enforces that only
 * the real current owner can invoke it.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const households = new HouseholdService(db, {} as never, {} as never); // MailerService/BillingService — unreached by transferOwnership

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
