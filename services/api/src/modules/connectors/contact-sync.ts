import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";

/**
 * Turning one provider's contact into this app's `people` / `aliases` / `contactSources` rows.
 *
 * Lifted out of `google-contacts.adapter.ts` so CardDAV (and the next contact source after it) uses the
 * same code rather than a second copy of it. The semantics here are not mechanical — they are a set of
 * decisions about somebody's address book, each of which is wrong in a different way if re-derived:
 *
 *   - A contact that DISAPPEARED from the provider does not delete the person. Someone may have attached
 *     notes, relationships and history to that row; an external signal must not destroy them. Only the
 *     "still synced" marker stops advancing.
 *   - A synced contact is PRIVATE, exactly like a hand-created one, even when the connection belongs to a
 *     household. Arriving through a shared connection is not consent to share.
 *   - Identity is keyed on the PROVIDER's contact id, never on a matching email or name. Alias-matching
 *     at import time silently merges two different people who share an address.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why the lookups are in-memory maps rather than SQL
 * ---------------------------------------------------------------------------------------------------
 * `contactSources.providerContactId` and `organizations.name` are ENCRYPTED AT REST with a fresh random
 * IV per row. Drizzle only decrypts on the way out, so a `where(eq(column, plaintext))` compares plaintext
 * against ciphertext and can never match. The original code did exactly that, and the result was not a
 * missing feature but compounding corruption: `existingSource` was always undefined, so every sync took
 * the "new contact" branch and inserted another person row for every contact in the address book, every
 * time it ran.
 *
 * That is why the indexes below are built once per sync from decrypted rows. It is also why this module
 * now has tests — it had none when that bug shipped.
 */

export interface ParsedContact {
  providerContactId: string;
  displayName: string;
  emails: string[];
  phones: string[];
  organizationName: string | null;
  deleted: boolean;
}

export interface ContactSyncIndexes {
  sources: Map<string, typeof schema.contactSources.$inferSelect>;
  organizations: Map<string, string>;
}

/**
 * Build both lookups once per sync, from decrypted rows.
 *
 * Scoped to this connection's own contact sources so two connections from the same provider never see
 * each other's rows, and to this owner's organizations.
 */
export async function buildContactSyncIndexes(
  db: Database,
  params: { ownerUserId: string; connectionId: string; provider: string },
): Promise<ContactSyncIndexes> {
  const sourceRows = await db
    .select()
    .from(schema.contactSources)
    .where(and(eq(schema.contactSources.connectionId, params.connectionId), eq(schema.contactSources.provider, params.provider)));

  const organizationRows = await db
    .select({ id: schema.organizations.id, name: schema.organizations.name })
    .from(schema.organizations)
    .where(eq(schema.organizations.ownerUserId, params.ownerUserId));

  return {
    sources: new Map(sourceRows.filter((r) => r.providerContactId).map((r) => [r.providerContactId as string, r])),
    organizations: new Map(organizationRows.map((r) => [r.name, r.id])),
  };
}

/**
 * Upsert one contact. Returns true when it created a NEW person, so a caller can count real discoveries
 * rather than re-syncs.
 */
export async function upsertContact(
  db: Database,
  params: {
    ownerUserId: string;
    householdId: string | null;
    connectionId: string;
    provider: string;
    contact: ParsedContact;
    indexes: ContactSyncIndexes;
  },
): Promise<boolean> {
  const { contact, indexes } = params;
  const existingSource = indexes.sources.get(contact.providerContactId);

  if (contact.deleted) {
    // Stop tracking it as still-synced; never destroy the person. See this module's doc comment.
    if (existingSource) {
      await db.update(schema.contactSources).set({ syncedAt: new Date() }).where(eq(schema.contactSources.id, existingSource.id));
    }
    return false;
  }

  let personId: string;
  if (existingSource) {
    personId = existingSource.personId;
    await db.update(schema.contactSources).set({ syncedAt: new Date() }).where(eq(schema.contactSources.id, existingSource.id));
    await db.update(schema.people).set({ displayName: contact.displayName, updatedAt: new Date() }).where(eq(schema.people.id, personId));
  } else {
    personId = generateId("person");
    await db.insert(schema.people).values({
      id: personId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      displayName: contact.displayName,
      // Private by default, exactly like a manually created person. A synced contact is not
      // household-visible just because it arrived through a household-linked connection.
      visibility: "private",
    });
    const inserted = {
      id: generateId("contactSource"),
      personId,
      ownerUserId: params.ownerUserId,
      provider: params.provider,
      connectionId: params.connectionId,
      providerContactId: contact.providerContactId,
      syncedAt: new Date(),
    };
    await db.insert(schema.contactSources).values(inserted);
    // Kept in the index so a provider that sends the same contact twice in one sync does not create it twice.
    indexes.sources.set(contact.providerContactId, inserted as unknown as typeof schema.contactSources.$inferSelect);
  }

  if (contact.organizationName) {
    const existingOrganizationId = indexes.organizations.get(contact.organizationName);
    const organizationId = existingOrganizationId ?? generateId("organization");
    if (!existingOrganizationId) {
      await db.insert(schema.organizations).values({ id: organizationId, ownerUserId: params.ownerUserId, name: contact.organizationName });
      indexes.organizations.set(contact.organizationName, organizationId);
    }
    await db.update(schema.people).set({ organizationId }).where(eq(schema.people.id, personId));
  }

  const existingAliases = await db.select().from(schema.aliases).where(eq(schema.aliases.personId, personId));
  const existingValues = new Set(existingAliases.map((a) => `${a.kind}:${a.value}`));
  for (const email of contact.emails) {
    if (existingValues.has(`email:${email}`)) continue;
    await db.insert(schema.aliases).values({ id: generateId("alias"), personId, ownerUserId: params.ownerUserId, kind: "email", value: email });
    existingValues.add(`email:${email}`);
  }
  for (const phone of contact.phones) {
    if (existingValues.has(`phone:${phone}`)) continue;
    await db.insert(schema.aliases).values({ id: generateId("alias"), personId, ownerUserId: params.ownerUserId, kind: "phone", value: phone });
    existingValues.add(`phone:${phone}`);
  }

  return !existingSource;
}
