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
const noopMailer = { send: async () => {} } as unknown as MailerService;

/**
 * FAM-006 bug found live during a requirements-traceability audit: `grantDelegation` requires the
 * delegate to be an active household member at grant time, but `delegatedHouseholdIds` (the read-side
 * consumer every domain's `ownerOrDelegatedHousehold` calls) never re-checked that afterward. A member
 * granted a still-unexpired delegation who then leaves the household (`HouseholdService.leave`, which
 * does not touch `caregiverDelegations`) kept full scoped read access to that household's lists/tasks/
 * etc. indefinitely — reproduced end-to-end via the live API: `GET /v1/households` correctly came back
 * empty post-leave, but `GET /v1/lists` still returned the household's shared list. This is exactly the
 * spec's own "Adult leaves household" FAM-* edge case, and a real privacy leak, not a cosmetic gap.
 */
describe("HouseholdService.delegatedHouseholdIds — stale delegation after leaving", () => {
  let db: Database;
  let households: HouseholdService;
  let ownerUserId: string;
  let delegateUserId: string;
  let householdId: string;
  let delegationId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    try {
      ownerUserId = generateId("user");
      delegateUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `deleg-leave-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: delegateUserId, email: `deleg-leave-delegate-${delegateUserId}@example.com`, displayName: "Delegate" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Delegation Leave Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: delegateUserId, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
      delegationId = generateId("caregiverDelegation");
      await db.insert(schema.caregiverDelegations).values({
        id: delegationId,
        householdId,
        delegateUserId,
        scopes: ["lists:read"],
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // still valid — the leak isn't about expiry
        grantedByUserId: ownerUserId,
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping HouseholdService delegation-post-leave test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.id, delegationId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, delegateUserId));
    }
  });

  it("still grants access while an active member, but not after leaving — even with an unexpired, unrevoked delegation", async () => {
    if (!dbAvailable) return;

    const whileMember = await households.delegatedHouseholdIds(delegateUserId, "lists:read");
    expect(whileMember).toContain(householdId);

    await households.leave(householdId, delegateUserId);

    const afterLeaving = await households.delegatedHouseholdIds(delegateUserId, "lists:read");
    expect(afterLeaving).not.toContain(householdId);

    // Sanity: the delegation row itself is untouched (still unrevoked, unexpired) — the fix filters at
    // read time by current membership, it doesn't (and shouldn't need to) mutate the delegation row.
    const [delegation] = await db.select().from(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.id, delegationId)).limit(1);
    expect(delegation).toBeDefined();
    expect(delegation!.revokedAt).toBeNull();
  });
});
