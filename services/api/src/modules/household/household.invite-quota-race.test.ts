import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { HouseholdService } from "./household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;

/**
 * `HouseholdService.invite` used to check the household's seat quota (a plain `SELECT count(...) >= max`)
 * and insert the new invite row as two separate, un-transacted statements — a classic TOCTOU race. Two
 * concurrent invites for the same household, both landing when there's exactly one seat left, could both
 * read the same "1 seat free" count before either write committed, letting the household exceed its
 * plan's `household_members_max`. Real DB test (not mocked) with a real Promise.all race, not a
 * sequential simulation, since the whole bug is about statement interleaving.
 */
describe("HouseholdService.invite — seat-quota race", () => {
  let db: Database;
  let households: HouseholdService;
  let ownerUserId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    try {
      ownerUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values({ id: ownerUserId, email: `invite-race-owner-${ownerUserId}@example.com`, displayName: "Owner" });
      await db.insert(schema.households).values({ id: householdId, name: "Race Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values({
        id: generateId("membership"),
        householdId,
        userId: ownerUserId,
        role: "household_owner",
        status: "active",
        joinedAt: new Date(),
      });
      // "family" plan → household_members_max = 6 (packages/core/src/entitlements/plans.ts). Owner (1) +
      // 4 filler invited rows = 5, leaving exactly ONE seat — the tightest window to race two concurrent
      // invite() calls against.
      await db.insert(schema.entitlements).values({
        id: generateId("entitlement"),
        userId: ownerUserId,
        planKey: "family",
        source: "web_stripe",
        effectiveFrom: new Date(Date.now() - 1000),
        effectiveTo: null,
      });
      await db.insert(schema.householdMemberships).values(
        Array.from({ length: 4 }, (_, i) => ({
          id: generateId("membership"),
          householdId,
          userId: null,
          role: "adult_member" as const,
          status: "invited" as const,
          invitedEmail: `filler-${i}-${householdId}@example.com`,
        })),
      );
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping HouseholdService invite-race test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.entitlements).where(eq(schema.entitlements.userId, ownerUserId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("never lets two concurrent invites both fill the last seat", async () => {
    if (!dbAvailable) return;
    const emailA = `racer-a-${householdId}@example.com`;
    const emailB = `racer-b-${householdId}@example.com`;

    const results = await Promise.allSettled([
      households.invite(householdId, ownerUserId, { email: emailA }),
      households.invite(householdId, ownerUserId, { email: emailB }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1); // exactly one of the two racers wins the last seat
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ response: { code: "HOUSEHOLD_MEMBER_LIMIT_REACHED" } });

    // The household's real membership count must never have exceeded the plan's max of 6.
    const rows = await db
      .select({ id: schema.householdMemberships.id })
      .from(schema.householdMemberships)
      .where(and(eq(schema.householdMemberships.householdId, householdId), inArray(schema.householdMemberships.status, ["active", "invited"])));
    expect(rows.length).toBeLessThanOrEqual(6);

    await db.delete(schema.householdMemberships).where(inArray(schema.householdMemberships.invitedEmail, [emailA, emailB]));
  });
});
