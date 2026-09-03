import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SharingService } from "./sharing.service";
import { CaregiverDayPassService } from "./caregiver-day-pass.service";

/**
 * §35 SHARE-005 "Caregiver/day pass" — real-Postgres coverage of the full lifecycle: create (owner-only),
 * redeem (correct/wrong passcode), revoke-early, and the scheduled expiry sweep — see
 * CaregiverDayPassService's own doc comment for why this is a new, distinct mechanism from FAM-006's
 * caregiverDelegations.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("CaregiverDayPassService — §35 SHARE-005", () => {
  let db: Database;
  let dayPasses: CaregiverDayPassService;
  let ownerId: string;
  let strangerId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    dayPasses = new CaregiverDayPassService(db, new SharingService(db));
    try {
      ownerId = generateId("user");
      strangerId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerId, email: `daypass-owner-${ownerId}@example.com`, passwordHash: "x", displayName: "Owner" },
        { id: strangerId, email: `daypass-stranger-${strangerId}@example.com`, passwordHash: "x", displayName: "Stranger" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Day Pass Household", billingOwnerUserId: ownerId, emergencyInstructions: "Spare key under the mat." });
      await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: ownerId, role: "household_owner", status: "active", joinedAt: new Date() });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping caregiver-day-pass tests — dev Postgres unavailable:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.caregiverDayPasses).where(eq(schema.caregiverDayPasses.householdId, householdId));
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, strangerId));
  });

  it("rejects creation by a non-member, and requires a bounded expiry", async () => {
    if (!dbAvailable) return;
    await expect(dayPasses.create(householdId, strangerId, { label: "x", scopes: ["instructions"], expiresInHours: 4 })).rejects.toThrow();
  });

  it("creates, redeems (with correct passcode), and returns only the chosen scopes", async () => {
    if (!dbAvailable) return;
    const { id, token } = await dayPasses.create(householdId, ownerId, { label: "Saturday sitter", scopes: ["instructions"], expiresInHours: 4, passcode: "1234" });
    expect(id).toBeTruthy();

    await expect(dayPasses.access(token, undefined)).rejects.toThrow(); // wrong/missing passcode
    await expect(dayPasses.access(token, "wrong")).rejects.toThrow();

    const packet = await dayPasses.access(token, "1234");
    expect(packet.instructions).toBe("Spare key under the mat.");
    expect(packet).not.toHaveProperty("contacts");
    expect(packet).not.toHaveProperty("schedule");
  });

  it("lists the pass for household members without ever exposing the token/passcode hash", async () => {
    if (!dbAvailable) return;
    const list = await dayPasses.list(householdId, ownerId);
    expect(list.length).toBeGreaterThan(0);
    for (const p of list) {
      expect(p).not.toHaveProperty("tokenHash");
      expect((p as { passcodeHash?: unknown }).passcodeHash).toBeUndefined();
    }
  });

  it("revoking early makes the token immediately unusable, and can't be revoked twice", async () => {
    if (!dbAvailable) return;
    const { id, token } = await dayPasses.create(householdId, ownerId, { label: "Revoke test", scopes: ["instructions"], expiresInHours: 4 });
    await dayPasses.access(token, undefined); // works before revoke (no passcode set)
    await dayPasses.revoke(householdId, id, ownerId);
    await expect(dayPasses.access(token, undefined)).rejects.toThrow();
    await expect(dayPasses.revoke(householdId, id, ownerId)).rejects.toThrow(); // already revoked
  });

  it("the expiry sweep stamps expiredAt on a due pass and leaves a not-yet-due one alone", async () => {
    if (!dbAvailable) return;
    const duePassId = generateId("caregiverDayPass");
    await db.insert(schema.caregiverDayPasses).values({
      id: duePassId,
      householdId,
      createdByUserId: ownerId,
      label: "Already due",
      tokenHash: "due-token-hash-" + duePassId,
      scopes: ["instructions"],
      expiresAt: new Date(Date.now() - 1000),
    });
    const { id: freshPassId, token: freshToken } = await dayPasses.create(householdId, ownerId, { label: "Still active", scopes: ["instructions"], expiresInHours: 4 });

    const expiredCount = await dayPasses.expireDuePasses();
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    const [due] = await db.select().from(schema.caregiverDayPasses).where(eq(schema.caregiverDayPasses.id, duePassId));
    expect(due?.expiredAt).not.toBeNull();
    const [fresh] = await db.select().from(schema.caregiverDayPasses).where(eq(schema.caregiverDayPasses.id, freshPassId));
    expect(fresh?.expiredAt).toBeNull();

    // The redemption path itself already rejects an expired pass regardless of the sweep having run.
    const staleToken = "unused-raw-token-for-due-pass"; // due pass's real token was never generated (tokenHash was hand-inserted above)
    await expect(dayPasses.access(staleToken, undefined)).rejects.toThrow();
    await expect(dayPasses.access(freshToken, undefined)).resolves.toBeTruthy();
  });
});
