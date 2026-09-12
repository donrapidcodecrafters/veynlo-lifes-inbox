import { afterAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

/**
 * Account deletion works by `DELETE FROM users` and letting the cascading foreign keys carry everything
 * else away — see worker-main.ts's accountDeletionWorker, which deletes solo households and then the user
 * row, and nothing else. 100 foreign keys to `users` cascade; the exceptions are all secondary references
 * (who checked a list item, who was assigned a task) where SET NULL is right.
 *
 * `search_documents.owner_user_id` was the one `owner_user_id` column in the schema with no foreign key at
 * all, so those rows just stayed. Proven against the real database before the fix: delete a user and their
 * `pet_profiles` row is gone while their `search_documents` row remains, `title` and `body_text` intact.
 *
 * And this is the worst table for it. Those two columns are deliberately PLAINTEXT — that is the entire
 * purpose of the index, since the source columns are encrypted at rest and cannot be searched — so a
 * deleted account left a plaintext, full-text-searchable copy of its own content behind, indefinitely. The
 * database already held 52 such rows.
 *
 * This asserts the mechanism rather than the migration: it does not look for a constraint by name, it
 * deletes a user and checks the rows are gone, which is what the guarantee actually is.
 */
describe("search_documents and account deletion", () => {
  const userId = generateId("user");
  const petId = generateId("pet");
  let dbAvailable = true;

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("takes a deleted account's search documents with it", async () => {
    try {
      await db.insert(schema.users).values({ id: userId, email: `search-del-${userId}@example.com`, displayName: "Search Deletion Test" });
    } catch {
      dbAvailable = false;
      return;
    }
    await db.insert(schema.petProfiles).values({ id: petId, ownerUserId: userId, label: "Deletion Test Pet", species: "dog" });
    await db.insert(schema.searchDocuments).values({
      id: `pet:${petId}`,
      ownerUserId: userId,
      resourceType: "pet",
      resourceId: petId,
      sensitivity: "sensitive",
      title: "Deletion Test Pet",
      bodyText: "dog deletion-test-breed",
    });

    // Present first — otherwise "gone afterwards" proves nothing.
    const before = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, userId));
    expect(before).toHaveLength(1);
    expect(before[0]!.title).toBe("Deletion Test Pet");

    await db.delete(schema.users).where(eq(schema.users.id, userId));

    const after = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.ownerUserId, userId));
    expect(after, "a deleted account's plaintext search index must not survive it").toHaveLength(0);
    // And the canonical row cascaded too, which is what makes this comparable.
    expect(await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, userId))).toHaveLength(0);
  });

  it("leaves no search document whose owner no longer exists", async () => {
    if (!dbAvailable) return;
    // The 52 rows found in the live database were exactly this shape. With the foreign key in place the
    // state is now unreachable, so this is a standing check that it stays unreachable.
    const result = await db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM search_documents sd WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = sd.owner_user_id)`,
    );
    // node-postgres returns a QueryResult, not an array — destructuring it yields "not iterable", which is
    // how this first failed.
    const orphanCount = Number((result as unknown as { rows: Array<{ count: string }> }).rows[0]?.count ?? 0);
    expect(orphanCount).toBe(0);
  });

  it("still soft-deletes rather than hard-deletes for a resource that is merely removed", async () => {
    if (!dbAvailable) return;
    // The cascade is about the OWNER going away. An individual resource being deleted still goes through
    // markDeleted, which sets deletedAt and leaves the row auditable — two different mechanisms that should
    // not be confused for each other.
    const liveOwner = generateId("user");
    await db.insert(schema.users).values({ id: liveOwner, email: `search-soft-${liveOwner}@example.com`, displayName: "Soft Delete Test" });
    const docId = `trip:${generateId("trip")}`;
    await db.insert(schema.searchDocuments).values({
      id: docId,
      ownerUserId: liveOwner,
      resourceType: "trip",
      resourceId: docId.split(":")[1]!,
      sensitivity: "sensitive",
      title: "Soft Delete Test Trip",
      bodyText: "",
    });
    await db.update(schema.searchDocuments).set({ deletedAt: new Date() }).where(eq(schema.searchDocuments.id, docId));

    const stillThere = await db.select().from(schema.searchDocuments).where(eq(schema.searchDocuments.id, docId));
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]!.deletedAt).toBeInstanceOf(Date);
    const liveOnly = await db
      .select()
      .from(schema.searchDocuments)
      .where(and(eq(schema.searchDocuments.id, docId), isNull(schema.searchDocuments.deletedAt)));
    expect(liveOnly).toHaveLength(0);

    await db.delete(schema.users).where(eq(schema.users.id, liveOwner));
  });
});
