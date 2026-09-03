import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";

/**
 * `saved_items.createdByUserId` used to `ON DELETE CASCADE` from `users.id`, unlike its sibling
 * `checkedByUserId`/`assignedToUserId` columns (already `SET NULL`). A saved item on a SHARED household
 * list is collaborative content — the list's owner/sharing boundary lives on `lists.householdId`, not on
 * who happened to type the item in. Before this fix, a household member who added a (non-private) item
 * to another member's shared list, then deleted their own account, silently deleted that item from the
 * WHOLE household's list — not just their own data. This is a real DB-level test (not a service-layer
 * mock) because the whole bug lived in the FK's `ON DELETE` action itself, not in application code.
 */
describe("saved_items survive their creator's account deletion", () => {
  let db: Database;
  let listOwnerUserId: string;
  let itemCreatorUserId: string;
  let listId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo");
    try {
      listOwnerUserId = generateId("user");
      itemCreatorUserId = generateId("user");
      listId = generateId("list");
      await db.insert(schema.users).values([
        { id: listOwnerUserId, email: `list-owner-${listOwnerUserId}@example.com`, displayName: "List Owner" },
        { id: itemCreatorUserId, email: `item-creator-${itemCreatorUserId}@example.com`, displayName: "Item Creator" },
      ]);
      await db.insert(schema.lists).values({ id: listId, ownerUserId: listOwnerUserId, name: "Shared Groceries", kind: "grocery" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping saved_items creator-deletion test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.lists).where(eq(schema.lists.id, listId));
      await db.delete(schema.users).where(eq(schema.users.id, listOwnerUserId));
      // itemCreatorUserId was already deleted by the test itself — confirm it's really gone, not just
      // untracked, so this test also proves the deletion it depends on actually happened.
      const remaining = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.id, itemCreatorUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("keeps a non-private saved item after its creator's account is deleted, only clearing the reference", async () => {
    if (!dbAvailable) return;
    const itemId = generateId("savedItem");
    await db.insert(schema.savedItems).values({
      id: itemId,
      listId,
      createdByUserId: itemCreatorUserId,
      label: "Milk",
      isPrivate: false,
    });

    // Simulates the account-deletion worker's final step (worker-main.ts's accountDeletionWorker) — the
    // real trigger for this cascade in production.
    await db.delete(schema.users).where(eq(schema.users.id, itemCreatorUserId));

    const [item] = await db.select().from(schema.savedItems).where(eq(schema.savedItems.id, itemId));
    expect(item).toBeDefined(); // the bug: this used to be undefined — the row was gone
    expect(item?.label).toBe("Milk");
    expect(item?.createdByUserId).toBeNull(); // reference cleared, not the row itself

    await db.delete(schema.savedItems).where(eq(schema.savedItems.id, itemId));
  });
});
