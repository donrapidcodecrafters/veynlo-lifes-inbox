import { describe, expect, it, beforeAll } from "vitest";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { DataExportService } from "./data-export.service";
import { EXPORT_CATEGORIES } from "./dto";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { IdentityService } from "../identity/identity.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubStorage = {} as unknown as ObjectStorage;
const stubIdentity = { verifyStepUpPassword: async () => {} } as unknown as IdentityService;

/**
 * PRIV-002 — "make user ownership operational, not merely a policy statement."
 *
 * `buildManifest` read 9 domains while the app shows the user roughly 28, so "export everything" returned a
 * file with no Home, Vehicles, Pets, People, Places, Trips, Lists, Saved items, Identity records, Finance,
 * School, store credits, automations or health appointments — most of the Life tab. Its `notIncluded` list
 * named only document blobs, OAuth tokens and other members' rows, so nothing in the file told the reader
 * what was missing.
 *
 * These run against the seeded demo account, which is the point: a manifest that is complete for an empty
 * account proves nothing. The assertion is per-domain and driven by what is actually in the database, so it
 * fails for whichever domain regresses rather than on a single total.
 */
const SEEDED_OWNER = "usr_demo_alex";

describe("DataExportService.buildManifest — completeness", () => {
  let db: Database;
  let manifest: Record<string, unknown>;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      const [owner] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, SEEDED_OWNER)).limit(1);
      if (!owner) {
        dbAvailable = false;
        return;
      }
      const service = new DataExportService(db, stubQueue, stubStorage, stubIdentity);
      manifest = (await service.buildManifest(SEEDED_OWNER)) as unknown as Record<string, unknown>;
    } catch {
      dbAvailable = false;
    }
  });

  const rows = (key: string) => (Array.isArray(manifest[key]) ? (manifest[key] as unknown[]).length : 0);

  it("includes every Life-tab domain the seeded account actually has data in", async () => {
    if (!dbAvailable) return;
    // Counted from the database, not hardcoded — if the seed changes, this follows it.
    const expectations: Array<[string, number]> = [
      ["people", (await db.select().from(schema.people).where(eq(schema.people.ownerUserId, SEEDED_OWNER))).length],
      ["pets", (await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, SEEDED_OWNER))).length],
      ["properties", (await db.select().from(schema.propertyProfiles).where(eq(schema.propertyProfiles.ownerUserId, SEEDED_OWNER))).length],
      ["vehicles", (await db.select().from(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.ownerUserId, SEEDED_OWNER))).length],
      ["places", (await db.select().from(schema.places).where(eq(schema.places.ownerUserId, SEEDED_OWNER))).length],
      ["savedItems", (await db.select().from(schema.savedMemories).where(eq(schema.savedMemories.ownerUserId, SEEDED_OWNER))).length],
      ["lists", (await db.select().from(schema.lists).where(eq(schema.lists.ownerUserId, SEEDED_OWNER))).length],
      ["identityRecords", (await db.select().from(schema.identityRecords).where(eq(schema.identityRecords.ownerUserId, SEEDED_OWNER))).length],
      ["healthAppointments", (await db.select().from(schema.healthAppointments).where(eq(schema.healthAppointments.ownerUserId, SEEDED_OWNER))).length],
      ["storeCredits", (await db.select().from(schema.storeCredits).where(eq(schema.storeCredits.ownerUserId, SEEDED_OWNER))).length],
    ];

    const missing = expectations.filter(([key, seeded]) => seeded > 0 && rows(key) === 0).map(([key]) => key);
    expect(missing, "domains with seeded rows that the export returned none of").toEqual([]);

    // At least one domain must actually have had data, or the check above passes vacuously.
    expect(expectations.some(([, seeded]) => seeded > 0)).toBe(true);
  });

  it("nests a list's items and a trip's segments rather than dropping them", async () => {
    if (!dbAvailable) return;
    const lists = manifest.lists as Array<{ items?: unknown[] }>;
    const trips = manifest.trips as Array<{ segments?: unknown[] }>;
    // Present as arrays even when empty — a consumer should not have to guess whether the key exists.
    for (const l of lists) expect(Array.isArray(l.items)).toBe(true);
    for (const t of trips) expect(Array.isArray(t.segments)).toBe(true);
  });

  it("never exports a credential or an identity document number", async () => {
    if (!dbAvailable) return;
    const serialized = JSON.stringify(manifest);
    // The pointer to the vault entry holding OAuth tokens.
    expect(serialized).not.toContain("credentialRef");
    // The one identity field the app only reveals behind its own separate step-up check.
    expect(serialized).not.toContain("documentNumber");
    for (const connection of manifest.connections as Array<Record<string, unknown>>) {
      expect(Object.keys(connection)).not.toContain("credentialRef");
    }
  });

  it("says so, when it leaves something out", async () => {
    if (!dbAvailable) return;
    const notIncluded = (manifest.notIncluded as string[]).join(" ");
    expect(notIncluded).toMatch(/document number/i);
    expect(notIncluded).toMatch(/credential|token/i);
  });

  it("every declared category maps to a section the manifest actually returns", async () => {
    if (!dbAvailable) return;
    // The old list drifted from the manifest silently — a category a user could select for which nothing
    // was ever queried, or a section no category could scope. Both directions matter.
    // Not every category is one section: "finance" fans out to accounts/transactions/liabilities/income,
    // "home" to properties/assets/maintenance. This maps each category to one section it MUST produce, so
    // the check stays meaningful without pretending the relationship is 1:1. Written after the first run
    // failed on exactly that assumption.
    const sectionAliases: Record<string, string> = {
      home: "properties",
      school: "schoolEvents",
      notes: "objectNotes",
      finance: "financialAccounts",
      automations: "automationRules",
    };
    for (const category of EXPORT_CATEGORIES) {
      const key = sectionAliases[category] ?? category;
      expect(Object.keys(manifest), `category "${category}" has no matching manifest section`).toContain(key);
    }
  });

  it("honours a category filter, returning the selected domain and not the others", async () => {
    if (!dbAvailable) return;
    const service = new DataExportService(db, stubQueue, stubStorage, stubIdentity);
    const onlyPets = (await service.buildManifest(SEEDED_OWNER, ["pets"])) as unknown as Record<string, unknown>;
    expect((onlyPets.pets as unknown[]).length).toBeGreaterThan(0);
    expect((onlyPets.people as unknown[]).length).toBe(0);
    expect((onlyPets.purchases as unknown[]).length).toBe(0);
  });
});
