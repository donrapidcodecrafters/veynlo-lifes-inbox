import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { DAVClient } from "tsdav";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CardDavAdapter } from "./carddav.adapter";
import { CredentialVault } from "../../common/credential-vault";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * CardDAV against a REAL CardDAV server over REAL TLS.
 *
 * The vCard parser and the contact upsert each have their own tests. What only a real server can show is
 * the join between them: that discovery finds the address book, that `fetchVCards` returns cards whose URL
 * is usable as a stable identity, and that a second sync recognises the same contacts rather than
 * duplicating an entire address book — which is precisely the bug this code path shipped once before.
 *
 * Radicale in Docker, with the same generated localhost certificate the other real-server suites use, so
 * the adapter's TLS requirement is exercised as it ships.
 *
 *   NODE_EXTRA_CA_CERTS=<repo>/.claude/test-certs/localhost-cert.pem \
 *     npx vitest run src/modules/connectors/carddav.adapter.test.ts
 *
 * Set REQUIRE_REAL_SERVER=1 to turn "server unreachable" from a skip into a failure.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const SERVER_URL = "https://localhost:5232";
const DAV_USER = "veynlo-contacts-test";

const stubEntitlements = {
  assertConnectorQuota: async () => {},
  resolveHistoricalBackfillDays: async () => 365,
  getCapability: async () => true,
} as unknown as EntitlementsService;
const stubQueue = { enqueueConnectorSync: async () => {} } as unknown as QueueProducer;

function davClient() {
  return new DAVClient({
    serverUrl: SERVER_URL,
    credentials: { username: DAV_USER, password: "any" },
    authMethod: "Basic",
    defaultAccountType: "carddav",
  });
}

const vcard = (uid: string, fn: string, email: string, org?: string) =>
  [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${uid}`,
    `FN:${fn}`,
    `EMAIL;TYPE=work:${email}`,
    ...(org ? [`ORG:${org}`] : []),
    "END:VCARD",
  ].join("\r\n");

/** Extended MKCOL (RFC 5689) — create a real address book collection on the server. */
async function createAddressBook(): Promise<void> {
  const body = [
    '<?xml version="1.0" encoding="utf-8" ?>',
    '<CARD:mkcol xmlns="DAV:" xmlns:CARD="urn:ietf:params:xml:ns:carddav">',
    "  <set><prop>",
    "    <resourcetype><collection/><CARD:addressbook/></resourcetype>",
    "    <displayname>Veynlo Contacts</displayname>",
    "  </prop></set>",
    "</CARD:mkcol>",
  ].join("\n");

  const response = await fetch(`${SERVER_URL}/${DAV_USER}/veynlo-contacts/`, {
    method: "MKCOL",
    headers: {
      "content-type": 'application/xml; charset="utf-8"',
      authorization: `Basic ${Buffer.from(`${DAV_USER}:any`).toString("base64")}`,
    },
    body,
  });
  // 405 means it already exists, which is fine on a re-run.
  if (!response.ok && response.status !== 405) {
    throw new Error(`MKCOL failed: ${response.status} ${await response.text()}`);
  }
}

describe("CardDavAdapter against a real CardDAV server", () => {
  let db: Database;
  let adapter: CardDavAdapter;
  let ownerUserId: string;
  let connectionId: string;
  let available = true;
  let addressBookUrl: string | null = null;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `carddav-test-${ownerUserId}@example.com`, displayName: "CardDAV Test" });
    } catch (err) {
      available = skipIfDatabaseUnreachable(err, "CardDavAdapter tests");
      return;
    }

    try {
      const client = davClient();
      await client.login();
      let books = await client.fetchAddressBooks();
      if (!books || books.length === 0) {
        // An address book is a COLLECTION carrying the carddav:addressbook resourcetype. A PUT into a
        // collection that does not exist does NOT create one, which is why the first version of this
        // setup found nothing and the suite skipped itself. Extended MKCOL is how a client makes one.
        await createAddressBook();
        books = await client.fetchAddressBooks();
      }
      const book = books?.[0];
      if (!book) throw new Error("no address book available");
      addressBookUrl = String(book.url);

      await client.createVCard({
        addressBook: book,
        filename: "veynlo-dana.vcf",
        vCardString: vcard("veynlo-dana", "Dana Holloway", "dana@example.test", "Northwind Traders"),
      });
      await client.createVCard({
        addressBook: book,
        filename: "veynlo-sam.vcf",
        vCardString: vcard("veynlo-sam", "Sam Okoro", "sam@example.test", "Northwind Traders"),
      });
    } catch (err) {
      console.warn(`Radicale is not reachable on ${SERVER_URL} — skipping the real-CardDAV suite. ${String((err as Error)?.message ?? err)}`);
      available = false;
      return;
    }

    const vault = new CredentialVault(db);
    adapter = new CardDavAdapter(db, vault, stubEntitlements, stubQueue);

    connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      householdId: null,
      provider: "carddav",
      feasibilityClass: "open_standard",
      scopes: ["contacts.read"],
      enabledCategories: ["people"],
      health: "initializing",
    });
    const credentialRef = await vault.store(
      connectionId,
      { serverUrl: SERVER_URL, username: DAV_USER, password: "any", providerKey: "custom" },
      null,
    );
    await db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));
  }, 90_000);

  afterAll(async () => {
    if (ownerUserId) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("actually reached the real server (REQUIRE_REAL_SERVER)", () => {
    if (process.env.REQUIRE_REAL_SERVER === "1") {
      expect(available, "REQUIRE_REAL_SERVER=1 but the server was unreachable — this suite proved nothing").toBe(true);
    } else if (!available) {
      console.warn("   (skipped: the real server was unreachable — set REQUIRE_REAL_SERVER=1 to make that a failure)");
    }
  });

  it("discovers address books and files their contacts over real TLS", async () => {
    if (!available) return;

    const result = await adapter.initialSync(connectionId);
    expect(result.itemCount, "no contacts were filed from the CardDAV server").toBeGreaterThan(0);

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    const dana = people.find((p) => p.displayName === "Dana Holloway");
    expect(dana, "the contact created on the server did not reach the database").toBeDefined();
    // Private by default, even though it arrived through a connection.
    expect(dana?.visibility).toBe("private");

    // The email came out of the vCard's own EMAIL property, through the parser, into an alias.
    const aliases = await db.select().from(schema.aliases).where(eq(schema.aliases.personId, dana!.id));
    expect(aliases.map((a) => a.value)).toContain("dana@example.test");
  }, 90_000);

  it("does not duplicate the address book on a second sync", async () => {
    if (!available) return;

    // The bug this code path shipped once: every sync inserted another person row for every contact.
    const before = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    const result = await adapter.incrementalSync(connectionId);
    const after = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));

    expect(after, "a re-sync duplicated the address book").toHaveLength(before.length);
    // Nothing NEW was discovered, which is a different statement from "nothing was synced".
    expect(result.itemCount).toBe(0);
  }, 90_000);

  it("reuses one organization row for contacts that share an employer", async () => {
    if (!available) return;
    const organizations = await db.select().from(schema.organizations).where(eq(schema.organizations.ownerUserId, ownerUserId));
    expect(organizations.filter((o) => o.name === "Northwind Traders")).toHaveLength(1);
  });

  it("picks up a contact added on the server after the first sync", async () => {
    if (!available || !addressBookUrl) return;

    const client = davClient();
    await client.login();
    const books = await client.fetchAddressBooks();
    const book = books?.find((b) => String(b.url) === addressBookUrl) ?? books?.[0];
    if (!book) return;

    // Unique per run. Radicale keeps its collections between runs, so a fixed filename meant the
    // "new" contact already existed from the previous run and was swept up by the FIRST sync — the
    // incremental one then correctly reported zero and the test failed for a reason that had nothing to
    // do with the code. Test isolation, not a product bug.
    const suffix = generateId("person").slice(-8);
    const name = `Added After Sync ${suffix}`;
    await client.createVCard({
      addressBook: book,
      filename: `veynlo-added-${suffix}.vcf`,
      vCardString: vcard(`veynlo-added-${suffix}`, name, `added-${suffix}@example.test`),
    });

    const result = await adapter.incrementalSync(connectionId);
    expect(result.itemCount).toBe(1);

    const people = await db.select().from(schema.people).where(eq(schema.people.ownerUserId, ownerUserId));
    expect(people.find((p) => p.displayName === name)).toBeDefined();
  }, 90_000);

  it("flags an unreachable server as degraded rather than leaving it healthy", async () => {
    if (!available) return;

    const vault = new CredentialVault(db);
    const brokenId = generateId("connection");
    await db.insert(schema.connections).values({
      id: brokenId,
      ownerUserId,
      householdId: null,
      provider: "carddav",
      feasibilityClass: "open_standard",
      scopes: ["contacts.read"],
      enabledCategories: ["people"],
      health: "healthy",
    });
    const ref = await vault.store(brokenId, { serverUrl: "https://localhost:5233", username: DAV_USER, password: "any", providerKey: "custom" }, null);
    await db.update(schema.connections).set({ credentialRef: ref }).where(eq(schema.connections.id, brokenId));

    await expect(adapter.initialSync(brokenId)).rejects.toThrow();

    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, brokenId));
    expect(connection?.health).toBe("degraded");
    expect(connection?.healthDetail).toBeTruthy();
  }, 90_000);
});
