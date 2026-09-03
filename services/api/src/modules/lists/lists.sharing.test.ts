import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ListsService } from "./lists.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";
import type { MemoriesService } from "../memories/memories.service";

// None of this file's fixtures create a smart list, so ListsService never calls into this — see
// lists.service.test.ts's identical stub for why an unimplemented-but-typed stub is enough.
const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002), generalized off documents onto lists — see
 * SharingService's own doc comment. Mirrors documents.sharing.test.ts's structure exactly: a stranger is
 * denied, a grant grants real access (including showing up in listLists()), revoking removes it, and a
 * share link's redemption content excludes private items (no anonymous identity to check
 * `isPrivate`/`createdByUserId` against — see ListsService.publicShareContent's own doc comment).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;

describe("ListsService object sharing", () => {
  let db: Database;
  let sharing: SharingService;
  let lists: ListsService;
  let ownerUserId: string;
  let granteeUserId: string;
  let granteeEmail: string;
  let strangerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    lists = new ListsService(db, stubHouseholds, sharing, stubMemories);
    try {
      ownerUserId = generateId("user");
      granteeUserId = generateId("user");
      granteeEmail = `list-share-grantee-${granteeUserId}@example.com`;
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `list-share-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: granteeUserId, email: granteeEmail, displayName: "Grantee" },
        { id: strangerUserId, email: `list-share-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping list sharing tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, granteeUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("resource grant: a stranger is denied, the grantee gains access, revoking removes it, and it shows up in the grantee's listLists()", async () => {
    if (!dbAvailable) return;
    const { id: listId } = await lists.createList(ownerUserId, { name: "Shared groceries", kind: "grocery" });
    await lists.addItem(listId, ownerUserId, { label: "Milk" });

    await expect(lists.listDetail(listId, strangerUserId)).rejects.toThrow();
    await expect(lists.createResourceGrant(listId, strangerUserId, granteeEmail)).rejects.toThrow(); // non-owner can't grant

    const { id: grantId } = await lists.createResourceGrant(listId, ownerUserId, granteeEmail);

    const granteeView = await lists.listDetail(listId, granteeUserId);
    expect(granteeView.items.map((i) => i.label)).toEqual(["Milk"]);
    expect((await lists.listLists(granteeUserId)).some((l) => l.id === listId)).toBe(true);

    await lists.revokeResourceGrant(grantId, ownerUserId);
    await expect(lists.listDetail(listId, granteeUserId)).rejects.toThrow();
    expect((await lists.listLists(granteeUserId)).some((l) => l.id === listId)).toBe(false);

    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
  });

  it("share link: resolves to the list's public, non-private items and revoking invalidates the token", async () => {
    if (!dbAvailable) return;
    const { id: listId } = await lists.createList(ownerUserId, { name: "Shared packing list", kind: "packing" });
    await lists.addItem(listId, ownerUserId, { label: "Passport" });
    await lists.addItem(listId, ownerUserId, { label: "Surprise gift", isPrivate: true });

    const { id: linkId, token } = await lists.createShareLink(listId, ownerUserId, {});

    const { resourceType, resourceId } = await sharing.resolveShareLink(token, undefined);
    expect(resourceType).toBe("list");
    const content = await lists.publicShareContent(resourceId);
    expect(content.name).toBe("Shared packing list");
    expect(content.items.map((i) => i.label)).toEqual(["Passport"]); // the private item never appears

    await lists.revokeShareLink(linkId, ownerUserId);
    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();

    await db.delete(schema.lists).where(eq(schema.lists.id, listId));
  });
});
