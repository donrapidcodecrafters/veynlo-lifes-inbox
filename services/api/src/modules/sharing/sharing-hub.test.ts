import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { SharingService } from "./sharing.service";
import { SharingHubService } from "./sharing-hub.service";
import type { PublicShareService } from "./public-share.service";

/**
 * §35 SHARE-007 "Central 'Shared by me' and 'Shared with me' screens" — real-Postgres coverage of
 * SharingHubService's own aggregation/filtering (not PublicShareService's per-resource-type label
 * dispatch, which is exercised by sharing-refactor-audit.test.ts/each resource's own sharing tests
 * already) — a stub `labelFor` is enough here since the hub's own job is choosing WHICH rows to include
 * and for WHOM, not how they're labeled.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubPublicShare = { labelFor: async () => "Stub label" } as unknown as PublicShareService;

describe("SharingHubService — §35 SHARE-007 shared-by-me / shared-with-me", () => {
  let db: Database;
  let sharing: SharingService;
  let hub: SharingHubService;
  let ownerId: string;
  let granteeId: string;
  let granteeEmail: string;
  let strangerId: string;
  let listId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    hub = new SharingHubService(db, sharing, stubPublicShare);
    try {
      ownerId = generateId("user");
      granteeId = generateId("user");
      strangerId = generateId("user");
      granteeEmail = `hub-grantee-${granteeId}@example.com`;
      listId = generateId("list");

      await db.insert(schema.users).values([
        { id: ownerId, email: `hub-owner-${ownerId}@example.com`, passwordHash: "x", displayName: "Owner" },
        { id: granteeId, email: granteeEmail, passwordHash: "x", displayName: "Grantee" },
        { id: strangerId, email: `hub-stranger-${strangerId}@example.com`, passwordHash: "x", displayName: "Stranger" },
      ]);
      await db.insert(schema.lists).values({ id: listId, ownerUserId: ownerId, name: "Hub test list", kind: "custom" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping sharing-hub tests — dev Postgres unavailable:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerId));
    await db.delete(schema.users).where(eq(schema.users.id, granteeId));
    await db.delete(schema.users).where(eq(schema.users.id, strangerId));
  });

  it("shows a grant under the granter's sharedByMe and the grantee's sharedWithMe, never the stranger's", async () => {
    if (!dbAvailable) return;
    const { id: grantId } = await sharing.createResourceGrant("list", listId, ownerId, granteeEmail);

    const byMe = await hub.sharedByMe(ownerId);
    expect(byMe.grants.map((g) => g.id)).toContain(grantId);
    expect(byMe.grants[0]!.resourceType).toBe("list");

    const withMe = await hub.sharedWithMe(granteeId);
    expect(withMe.map((g) => g.id)).toContain(grantId);
    expect(withMe[0]!.granterEmail).toContain("hub-owner-");

    expect((await hub.sharedByMe(strangerId)).grants).toHaveLength(0);
    expect(await hub.sharedWithMe(strangerId)).toHaveLength(0);

    // Revoking from the hub must take effect immediately on both sides, same as revoking from the
    // resource's own ShareResourcePanel would.
    await hub.revokeGrant(grantId, ownerId);
    expect((await hub.sharedByMe(ownerId)).grants).toHaveLength(0);
    expect(await hub.sharedWithMe(granteeId)).toHaveLength(0);
  });

  it("only the original granter (not an arbitrary user) can revoke from the hub", async () => {
    if (!dbAvailable) return;
    const { id: grantId } = await sharing.createResourceGrant("list", listId, ownerId, granteeEmail);
    await expect(hub.revokeGrant(grantId, strangerId)).rejects.toThrow();
    // Still active — the rejected revoke attempt must not have silently succeeded.
    expect((await hub.sharedByMe(ownerId)).grants.map((g) => g.id)).toContain(grantId);
    await hub.revokeGrant(grantId, ownerId); // cleanup
  });

  it("shows a share link under sharedByMe and revoking it removes it", async () => {
    if (!dbAvailable) return;
    const { id: linkId } = await sharing.createShareLink("list", listId, ownerId, {});
    const byMe = await hub.sharedByMe(ownerId);
    expect(byMe.links.map((l) => l.id)).toContain(linkId);

    await hub.revokeShareLink(linkId, ownerId);
    expect((await hub.sharedByMe(ownerId)).links.map((l) => l.id)).not.toContain(linkId);
  });
});
