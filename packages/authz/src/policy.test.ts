import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { resolveAccess } from "./policy";

/**
 * Runs against the real local Postgres (docker-compose) rather than a mock —
 * authorization is the single most consequential code path in Veynlo
 * (§45 threat register: "broken object authorization / cross-tenant leak"),
 * so it is tested against real household/grant rows, not a stubbed DB client.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
const ownerUserId = generateId("user");
const householdMemberUserId = generateId("user");
const outsiderUserId = generateId("user");
const strangerUserId = generateId("user");
const householdId = generateId("household");
const privateResourceId = generateId("document");
const householdResourceId = generateId("document");
const grantedResourceId = generateId("document");

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  await db.insert(schema.users).values([
    { id: ownerUserId, displayName: "Owner" },
    { id: householdMemberUserId, displayName: "Household Member" },
    { id: outsiderUserId, displayName: "Outsider" },
    { id: strangerUserId, displayName: "Stranger" },
  ]);
  await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });
  await db.insert(schema.householdMemberships).values([
    { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active" },
    { id: generateId("membership"), householdId, userId: householdMemberUserId, role: "adult_member", status: "active" },
  ]);
  await db.insert(schema.resourceGrants).values({
    id: generateId("resourceGrant"),
    resourceType: "document",
    resourceId: grantedResourceId,
    granteeUserId: outsiderUserId,
    right: "view",
    grantedByUserId: ownerUserId,
  });
});

afterAll(async () => {
  // Narrow deletes scoped to exactly the rows this suite created.
  const { eq, inArray } = await import("drizzle-orm");
  await db.delete(schema.resourceGrants).where(eq(schema.resourceGrants.granteeUserId, outsiderUserId));
  await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
  await db.delete(schema.households).where(eq(schema.households.id, householdId));
  await db
    .delete(schema.users)
    .where(inArray(schema.users.id, [ownerUserId, householdMemberUserId, outsiderUserId, strangerUserId]));
});

describe("resolveAccess", () => {
  it("always grants the owner full manage rights", async () => {
    const decision = await resolveAccess(db, ownerUserId, {
      resourceType: "document",
      resourceId: privateResourceId,
      ownerUserId,
      householdId: null,
      visibility: "private",
    });
    expect(decision).toEqual({ allowed: true, right: "manage", reason: "owner" });
  });

  it("denies a private resource to everyone except the owner, even a household member", async () => {
    const decision = await resolveAccess(db, householdMemberUserId, {
      resourceType: "document",
      resourceId: privateResourceId,
      ownerUserId,
      householdId,
      visibility: "private",
    });
    expect(decision.allowed).toBe(false);
  });

  it("grants view access to an active household member on a household-visible resource", async () => {
    const decision = await resolveAccess(db, householdMemberUserId, {
      resourceType: "document",
      resourceId: householdResourceId,
      ownerUserId,
      householdId,
      visibility: "household",
    });
    expect(decision).toEqual({ allowed: true, right: "view", reason: "household_member" });
  });

  it("denies a household-visible resource to someone outside the household", async () => {
    const decision = await resolveAccess(db, strangerUserId, {
      resourceType: "document",
      resourceId: householdResourceId,
      ownerUserId,
      householdId,
      visibility: "household",
    });
    expect(decision.allowed).toBe(false);
  });

  it("honors an explicit resource grant for a non-household principal", async () => {
    const decision = await resolveAccess(db, outsiderUserId, {
      resourceType: "document",
      resourceId: grantedResourceId,
      ownerUserId,
      householdId: null,
      visibility: "selected_people",
    });
    expect(decision).toEqual({ allowed: true, right: "view", reason: "explicit_grant" });
  });

  it("denies access with no owner match, no household membership, and no grant", async () => {
    const decision = await resolveAccess(db, strangerUserId, {
      resourceType: "document",
      resourceId: grantedResourceId,
      ownerUserId,
      householdId: null,
      visibility: "selected_people",
    });
    expect(decision.allowed).toBe(false);
  });
});
