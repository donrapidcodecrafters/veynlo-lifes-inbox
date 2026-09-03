import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SharingService } from "./sharing.service";

/**
 * §35 SHARE-004/007 "access_audit" — the previously entirely-missing "who's viewed this" ledger (see
 * accessAuditEvents' own doc comment, packages/db/src/schema/sharing.ts). Exercises the two automatic
 * write sites (hasActiveGrant, resolveShareLink) plus the explicit recordGrantAccess escape hatch a
 * handful of resource modules use instead (PeopleService/PetsService/AssetsService/CommerceService — see
 * each of their own doc comments), against real dev Postgres.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("SharingService — access audit log (§35 SHARE-004/007)", () => {
  let db: Database;
  let sharing: SharingService;
  let ownerId: string;
  let granteeId: string;
  let granteeEmail: string;
  let listId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    try {
      ownerId = generateId("user");
      granteeId = generateId("user");
      granteeEmail = `access-audit-grantee-${granteeId}@example.com`;
      listId = generateId("list");

      await db.insert(schema.users).values([
        { id: ownerId, email: `access-audit-owner-${ownerId}@example.com`, passwordHash: "x", displayName: "Owner" },
        { id: granteeId, email: granteeEmail, passwordHash: "x", displayName: "Grantee" },
      ]);
      await db.insert(schema.lists).values({ id: listId, ownerUserId: ownerId, name: "Test list", kind: "custom" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping access-audit tests — dev Postgres unavailable:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, granteeId));
  });

  it("hasActiveGrant records an access event only when it actually finds an active grant", async () => {
    if (!dbAvailable) return;
    // No grant exists yet — a failed check must not be recorded as an "access".
    expect(await sharing.hasActiveGrant("list", listId, granteeId)).toBe(false);
    expect(await sharing.listAccessEvents("list", listId)).toHaveLength(0);

    const { id: grantId } = await sharing.createResourceGrant("list", listId, ownerId, granteeEmail);
    expect(await sharing.hasActiveGrant("list", listId, granteeId)).toBe(true);

    const events = await sharing.listAccessEvents("list", listId);
    expect(events).toHaveLength(1);
    expect(events[0]!.accessMethod).toBe("grant");
    expect(events[0]!.accessedByEmail).toBe(granteeEmail);

    // Revoking must both stop granting access AND stop it from being logged as a future access.
    await sharing.revokeResourceGrant(grantId, ownerId);
    expect(await sharing.hasActiveGrant("list", listId, granteeId)).toBe(false);
    expect(await sharing.listAccessEvents("list", listId)).toHaveLength(1); // unchanged — the revoked check itself isn't logged
  });

  it("resolveShareLink records an anonymous access event carrying the link, not a user", async () => {
    if (!dbAvailable) return;
    const { id: linkId, token } = await sharing.createShareLink("list", listId, ownerId, {});
    const before = (await sharing.listAccessEvents("list", listId)).length;

    await sharing.resolveShareLink(token, undefined);

    const events = await sharing.listAccessEvents("list", listId);
    expect(events).toHaveLength(before + 1);
    const linkEvent = events.find((e) => e.accessMethod === "share_link");
    expect(linkEvent).toBeDefined();
    expect(linkEvent!.accessedByEmail).toBeNull();

    // Confirm the row really does carry this link's id (not just "some share_link event").
    const [raw] = await db.select().from(schema.accessAuditEvents).where(eq(schema.accessAuditEvents.shareLinkId, linkId));
    expect(raw?.resourceType).toBe("list");
    expect(raw?.resourceId).toBe(listId);
  });

  it("an expired/revoked share link never logs an access, even though it's rejected", async () => {
    if (!dbAvailable) return;
    const { id: linkId, token } = await sharing.createShareLink("list", listId, ownerId, {});
    await sharing.revokeShareLink(linkId, ownerId);

    const before = (await sharing.listAccessEvents("list", listId)).length;
    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();
    expect(await sharing.listAccessEvents("list", listId)).toHaveLength(before);
  });

  it("recordGrantAccess (the explicit escape hatch for pets/assets/commerce/people-shaped gates) writes the same shape of row", async () => {
    if (!dbAvailable) return;
    const otherListId = generateId("list");
    await db.insert(schema.lists).values({ id: otherListId, ownerUserId: ownerId, name: "Second test list", kind: "custom" });
    try {
      await sharing.recordGrantAccess("list", otherListId, granteeId);
      const events = await sharing.listAccessEvents("list", otherListId);
      expect(events).toHaveLength(1);
      expect(events[0]!.accessMethod).toBe("grant");
      expect(events[0]!.accessedByEmail).toBe(granteeEmail);
    } finally {
      await db.delete(schema.lists).where(eq(schema.lists.id, otherListId));
    }
  });
});
