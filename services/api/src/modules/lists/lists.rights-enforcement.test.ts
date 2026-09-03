import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ListsService } from "./lists.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";
import type { MemoriesService } from "../memories/memories.service";

/**
 * SHARE-001 "Set view/edit/manage" — adversarial proof that a grant's `right` is actually enforced on
 * every list write path, not just read access (lists.sharing.test.ts already covers the read/grant/revoke
 * basics; this file is specifically about the right LEVEL). Mirrors sharing-refactor-audit.test.ts's
 * real-Postgres, cross-account pattern: three separate grantee accounts (view/edit/manage), none of them
 * household members of the owner, so every access path they get is exclusively through their grant's
 * right — nothing else is silently doing the authorizing.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubMemories = { evaluateSmartQuery: async () => [] } as unknown as MemoriesService;
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;

describe("ListsService SHARE-001 right enforcement (view/edit/manage)", () => {
  let db: Database;
  let sharing: SharingService;
  let lists: ListsService;
  let ownerUserId: string;
  let viewerUserId: string;
  let editorUserId: string;
  let managerUserId: string;
  let listId: string;
  let viewerGrantId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    lists = new ListsService(db, stubHouseholds, sharing, stubMemories);
    try {
      ownerUserId = generateId("user");
      viewerUserId = generateId("user");
      editorUserId = generateId("user");
      managerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `list-rights-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: viewerUserId, email: `list-rights-viewer-${viewerUserId}@example.com`, displayName: "Viewer" },
        { id: editorUserId, email: `list-rights-editor-${editorUserId}@example.com`, displayName: "Editor" },
        { id: managerUserId, email: `list-rights-manager-${managerUserId}@example.com`, displayName: "Manager" },
      ]);

      const created = await lists.createList(ownerUserId, { name: "Rights test list", kind: "custom" });
      listId = created.id;

      const [viewerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, viewerUserId)).limit(1);
      const [editorRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, editorUserId)).limit(1);
      const [managerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, managerUserId)).limit(1);

      const viewerGrant = await lists.createResourceGrant(listId, ownerUserId, viewerRow!.email!, undefined, "view", "Welcome to the list!");
      viewerGrantId = viewerGrant.id;
      await lists.createResourceGrant(listId, ownerUserId, editorRow!.email!, undefined, "edit");
      await lists.createResourceGrant(listId, ownerUserId, managerRow!.email!, undefined, "manage");
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping list rights-enforcement tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.lists).where(eq(schema.lists.id, listId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, viewerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, editorUserId));
      await db.delete(schema.users).where(eq(schema.users.id, managerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("a 'view' grant can read (and sees the granter's optional message) but cannot write anything", async () => {
    if (!dbAvailable) return;
    const detail = await lists.listDetail(listId, viewerUserId);
    expect(detail.list.id).toBe(listId);
    expect(detail.sharedNote).toBe("Welcome to the list!");

    await expect(lists.addItem(listId, viewerUserId, { label: "Should not be allowed" })).rejects.toThrow();
    await expect(lists.updateList(listId, viewerUserId, { name: "Hijacked" })).rejects.toThrow();
    await expect(lists.deleteList(listId, viewerUserId)).rejects.toThrow();
    await expect(lists.createResourceGrant(listId, viewerUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
    await expect(lists.createShareLink(listId, viewerUserId, {})).rejects.toThrow();
    await expect(lists.revokeResourceGrant(viewerGrantId, viewerUserId)).rejects.toThrow();
  });

  it("an 'edit' grant can modify the list's own fields/items but cannot delete the list or re-share it", async () => {
    if (!dbAvailable) return;
    const { id: itemId } = await lists.addItem(listId, editorUserId, { label: "Added by editor" });
    await lists.updateItem(itemId, editorUserId, { checked: true });
    await lists.updateList(listId, editorUserId, { name: "Edited by editor" });
    const renamed = await lists.listDetail(listId, editorUserId);
    expect(renamed.list.name).toBe("Edited by editor");

    // "edit" covers the list's own items (spec: "modify the resource's own fields/items"), so deleting an
    // item it can see is allowed — but the LIST itself, and re-sharing, are not.
    await lists.deleteItem(itemId, editorUserId);

    await expect(lists.deleteList(listId, editorUserId)).rejects.toThrow();
    await expect(lists.createResourceGrant(listId, editorUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
    await expect(lists.createShareLink(listId, editorUserId, {})).rejects.toThrow();
    await expect(lists.revokeResourceGrant(viewerGrantId, editorUserId)).rejects.toThrow();
  });

  it("a 'manage' grant can create/revoke other grants and delete the list itself, but never becomes the owner", async () => {
    if (!dbAvailable) return;
    const tempGranteeId = generateId("user");
    const tempGranteeEmail = `list-rights-temp-${tempGranteeId}@example.com`;
    await db.insert(schema.users).values({ id: tempGranteeId, email: tempGranteeEmail, displayName: "Temp" });

    // "manage" can grant/revoke OTHER users' access, not just the owner.
    const { id: tempGrantId } = await lists.createResourceGrant(listId, managerUserId, tempGranteeEmail, undefined, "view");
    expect((await lists.listResourceGrants(listId, managerUserId)).some((g) => g.grant.id === tempGrantId)).toBe(true);
    await lists.revokeResourceGrant(tempGrantId, managerUserId);

    await lists.updateList(listId, managerUserId, { name: "Managed by manager" });

    // Ownership never transfers — the owner column is untouched by anything "manage" can do.
    const stillOwnedByOriginalOwner = await db.select({ ownerUserId: schema.lists.ownerUserId }).from(schema.lists).where(eq(schema.lists.id, listId)).limit(1);
    expect(stillOwnedByOriginalOwner[0]?.ownerUserId).toBe(ownerUserId);

    // "manage = edit + delete" — deleting the list itself is manage-only (proven negatively by the "edit"
    // test above); a manager CAN do it. Last assertion in this file since it removes the shared fixture.
    await lists.deleteList(listId, managerUserId);
    await expect(lists.listDetail(listId, ownerUserId)).rejects.toThrow();

    await db.delete(schema.users).where(eq(schema.users.id, tempGranteeId));
  });
});
