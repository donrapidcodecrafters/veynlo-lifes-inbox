import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { buildContactSyncIndexes, upsertContact, type ParsedContact } from "./contact-sync";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * The contact upsert every contact connector shares.
 *
 * This logic had ZERO tests until now, and its own doc comment records what that cost: because
 * `contactSources.providerContactId` is encrypted at rest with a random IV per row, a SQL
 * `where(eq(column, plaintext))` could never match, so every sync took the "new contact" branch and
 * inserted another person row for every contact in the address book, every time it ran. Not a missing
 * feature — compounding corruption, shipped, because nothing asked the question.
 *
 * The first test below is that question, asked permanently.
 *
 * Every write here is real. There is no provider and no network: this is the half that runs after any
 * provider has been parsed, which is exactly why it is worth testing on its own.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

function contact(overrides: Partial<ParsedContact> & { providerContactId: string }): ParsedContact {
  return {
    displayName: "Unnamed contact",
    emails: [],
    phones: [],
    organizationName: null,
    deleted: false,
    ...overrides,
  };
}

describe("shared contact upsert", () => {
  let db: Database;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;

  const baseParams = () => ({ ownerUserId, householdId: null, connectionId, provider: "carddav" });

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `contact-sync-${ownerUserId}@example.com`, displayName: "Contact Sync Test" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "carddav",
        feasibilityClass: "open_standard",
        scopes: ["contacts.read"],
        enabledCategories: ["people"],
        health: "healthy",
      });
    } catch (err) {
      dbAvailable = skipIfDatabaseUnreachable(err, "contact sync tests");
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("does not create a second person when the same contact is synced again", async () => {
    if (!dbAvailable) return;

    // THE regression test. This is the bug that shipped: re-running a sync duplicated every contact.
    const id = `urn:test:${generateId("person")}`;
    const input = contact({ providerContactId: id, displayName: "Dana Holloway", emails: ["dana@example.test"] });

    for (let run = 0; run < 3; run++) {
      const indexes = await buildContactSyncIndexes(db, baseParams());
      const created = await upsertContact(db, { ...baseParams(), contact: input, indexes });
      // Only the first run is a discovery; the rest are re-syncs.
      expect(created, `run ${run} reported the wrong "created" result`).toBe(run === 0);
    }

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    const matching = people.filter((p) => p.displayName === "Dana Holloway");
    expect(matching, "the same contact produced more than one person row").toHaveLength(1);

    const sources = await db.select().from(schema.contactSources).where(eq(schema.contactSources.connectionId, connectionId));
    expect(sources.filter((s) => s.providerContactId === id)).toHaveLength(1);
  });

  it("finds an existing contact through the encrypted provider id", async () => {
    if (!dbAvailable) return;

    // The index is built from DECRYPTED rows for a reason — a SQL comparison against this column compares
    // plaintext to ciphertext and silently matches nothing. Proving the lookup works is proving that.
    const id = `urn:test:${generateId("person")}`;
    let indexes = await buildContactSyncIndexes(db, baseParams());
    await upsertContact(db, { ...baseParams(), contact: contact({ providerContactId: id, displayName: "First Name" }), indexes });

    indexes = await buildContactSyncIndexes(db, baseParams());
    expect(indexes.sources.get(id), "the freshly built index could not find a contact it just wrote").toBeDefined();
  });

  it("updates the display name in place when a contact is renamed upstream", async () => {
    if (!dbAvailable) return;

    const id = `urn:test:${generateId("person")}`;
    let indexes = await buildContactSyncIndexes(db, baseParams());
    await upsertContact(db, { ...baseParams(), contact: contact({ providerContactId: id, displayName: "Sam Okoro" }), indexes });

    indexes = await buildContactSyncIndexes(db, baseParams());
    await upsertContact(db, { ...baseParams(), contact: contact({ providerContactId: id, displayName: "Samuel Okoro" }), indexes });

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    expect(people.filter((p) => p.displayName === "Samuel Okoro")).toHaveLength(1);
    expect(people.filter((p) => p.displayName === "Sam Okoro")).toHaveLength(0);
  });

  it("keeps the person when the contact disappears from the provider", async () => {
    if (!dbAvailable) return;

    // A person row can carry notes, relationships and history a user built by hand. An address book
    // deletion upstream must never destroy that.
    const id = `urn:test:${generateId("person")}`;
    let indexes = await buildContactSyncIndexes(db, baseParams());
    await upsertContact(db, { ...baseParams(), contact: contact({ providerContactId: id, displayName: "Removed Upstream" }), indexes });

    indexes = await buildContactSyncIndexes(db, baseParams());
    const created = await upsertContact(db, {
      ...baseParams(),
      contact: contact({ providerContactId: id, displayName: "Removed Upstream", deleted: true }),
      indexes,
    });
    expect(created).toBe(false);

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    expect(people.filter((p) => p.displayName === "Removed Upstream"), "a deleted contact destroyed its person row").toHaveLength(1);
  });

  it("makes a synced contact private, not household-visible", async () => {
    if (!dbAvailable) return;

    // Arriving through a household-linked connection is not consent to share.
    const id = `urn:test:${generateId("person")}`;
    const indexes = await buildContactSyncIndexes(db, baseParams());
    await upsertContact(db, {
      ...baseParams(),
      householdId: null,
      contact: contact({ providerContactId: id, displayName: "Private By Default" }),
      indexes,
    });

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    expect(people.find((p) => p.displayName === "Private By Default")?.visibility).toBe("private");
  });

  it("does not duplicate aliases across repeated syncs", async () => {
    if (!dbAvailable) return;

    const id = `urn:test:${generateId("person")}`;
    const input = contact({
      providerContactId: id,
      displayName: "Alias Person",
      emails: ["alias@example.test", "alias.work@example.test"],
      phones: ["+15555550100"],
    });

    for (let run = 0; run < 3; run++) {
      const indexes = await buildContactSyncIndexes(db, baseParams());
      await upsertContact(db, { ...baseParams(), contact: input, indexes });
    }

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    const person = people.find((p) => p.displayName === "Alias Person")!;
    const aliases = await db.select().from(schema.aliases).where(eq(schema.aliases.personId, person.id));
    expect(aliases.filter((a) => a.kind === "email")).toHaveLength(2);
    expect(aliases.filter((a) => a.kind === "phone")).toHaveLength(1);
  });

  it("reuses one organization row for contacts that share an employer", async () => {
    if (!dbAvailable) return;

    const organizationName = `Northwind ${generateId("organization").slice(-6)}`;
    for (const name of ["Colleague One", "Colleague Two"]) {
      const indexes = await buildContactSyncIndexes(db, baseParams());
      await upsertContact(db, {
        ...baseParams(),
        contact: contact({ providerContactId: `urn:test:${name}:${organizationName}`, displayName: name, organizationName }),
        indexes,
      });
    }

    const organizations = await db.select().from(schema.organizations).where(eq(schema.organizations.ownerUserId, ownerUserId));
    // Encrypted column again: without the decrypted index, this would be two rows for one employer.
    expect(organizations.filter((o) => o.name === organizationName), "one employer produced more than one organization row").toHaveLength(1);
  });

  it("does not create the same contact twice within a single sync", async () => {
    if (!dbAvailable) return;

    // A provider that lists the same contact twice in one page must not produce two people. The index is
    // updated in place after an insert precisely so the second occurrence is recognised.
    const id = `urn:test:${generateId("person")}`;
    const indexes = await buildContactSyncIndexes(db, baseParams());
    const input = contact({ providerContactId: id, displayName: "Listed Twice" });

    const first = await upsertContact(db, { ...baseParams(), contact: input, indexes });
    const second = await upsertContact(db, { ...baseParams(), contact: input, indexes });
    expect(first).toBe(true);
    expect(second).toBe(false);

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    expect(people.filter((p) => p.displayName === "Listed Twice")).toHaveLength(1);
  });
});
