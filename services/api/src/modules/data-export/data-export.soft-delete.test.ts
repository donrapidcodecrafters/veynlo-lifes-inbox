import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { DataExportService } from "./data-export.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { IdentityService } from "../identity/identity.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubStorage = {} as unknown as ObjectStorage;
const stubIdentity = { verifyStepUpPassword: async () => {} } as unknown as IdentityService;

/**
 * `buildManifest` excludes soft-deleted rows for ten domains — people, organizations, pets, properties,
 * homeAssets, vehicles, places, trips, identityRecords, healthAppointments, refillReminders all carry
 * `isNull(deletedAt)` — and for five it did not: documents, personNotes, personImportantDates,
 * maintenanceRules, registrationRecords.
 *
 * So "download all my data" handed back documents and notes the user had deleted, while the row next to it
 * in the same function correctly left deleted people out. A user who deletes something and then exports has
 * every reason to expect it gone; getting it back in the file is the opposite of what deleting meant, and
 * the inconsistency inside one function is what makes it a defect rather than a policy.
 *
 * The fixture builds its own account rather than soft-deleting seeded demo rows, so a failure part-way
 * through cannot leave the demo account with data missing from the UI.
 */
describe("DataExportService.buildManifest — soft-deleted rows", () => {
  let db: Database;
  let manifest: Record<string, unknown>;
  let dbAvailable = true;
  let setupError: Error | null = null;

  const userId = generateId("user");
  const personId = generateId("person");
  const vehicleId = generateId("vehicle");
  const live = {
    document: generateId("document"),
    note: generateId("personNote"),
    date: generateId("personImportantDate"),
    rule: generateId("maintenanceRule"),
    registration: generateId("registrationRecord"),
  };
  const deleted = {
    document: generateId("document"),
    note: generateId("personNote"),
    date: generateId("personImportantDate"),
    rule: generateId("maintenanceRule"),
    registration: generateId("registrationRecord"),
  };

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      await db.insert(schema.users).values({ id: userId, email: `export-soft-${userId}@example.com`, displayName: "Soft Delete Export" });
    } catch {
      dbAvailable = false;
      return;
    }
    try {
      const deletedAt = new Date();
      await db.insert(schema.people).values({ id: personId, ownerUserId: userId, displayName: "Fixture Person" });
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId: userId, label: "Fixture Vehicle" });

      await db.insert(schema.documents).values([
        { id: live.document, ownerUserId: userId, documentType: "receipt", title: "Kept Document", tags: [] },
        { id: deleted.document, ownerUserId: userId, documentType: "receipt", title: "Deleted Document", tags: [], deletedAt },
      ]);
      await db.insert(schema.personNotes).values([
        { id: live.note, personId, ownerUserId: userId, authorUserId: userId, body: "Kept note" },
        { id: deleted.note, personId, ownerUserId: userId, authorUserId: userId, body: "Deleted note", deletedAt },
      ]);
      const date = { date: "2026-12-01", timezone: null, precision: "date", instantUtc: null, sourceText: null } as const;
      await db.insert(schema.personImportantDates).values([
        { id: live.date, personId, ownerUserId: userId, label: "Kept date", date },
        { id: deleted.date, personId, ownerUserId: userId, label: "Deleted date", date, deletedAt },
      ]);
      await db.insert(schema.maintenanceRules).values([
        { id: live.rule, ownerUserId: userId, label: "Kept rule", intervalType: "calendar" },
        { id: deleted.rule, ownerUserId: userId, label: "Deleted rule", intervalType: "calendar", deletedAt },
      ]);
      await db.insert(schema.registrationRecords).values([
        { id: live.registration, ownerUserId: userId, vehicleProfileId: vehicleId },
        { id: deleted.registration, ownerUserId: userId, vehicleProfileId: vehicleId, deletedAt },
      ]);

      const service = new DataExportService(db, stubQueue, stubStorage, stubIdentity);
      manifest = (await service.buildManifest(userId)) as unknown as Record<string, unknown>;
    } catch (error) {
      setupError = error as Error;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  const ids = (key: string) => ((manifest?.[key] as Array<{ id: string }> | undefined) ?? []).map((r) => r.id);

  it("built the fixture and the manifest", () => {
    if (!dbAvailable) return;
    // Without this the checks below pass vacuously on an empty manifest — which is exactly how an earlier
    // test in this audit reported three green passes while its setup was throwing.
    expect(setupError, setupError?.message).toBeNull();
  });

  const cases: Array<[string, keyof typeof live]> = [
    ["documents", "document"],
    ["personNotes", "note"],
    ["personImportantDates", "date"],
    ["maintenanceRules", "rule"],
    ["registrationRecords", "registration"],
  ];

  for (const [section, key] of cases) {
    it(`excludes a soft-deleted row from ${section}, and keeps the live one`, () => {
      if (!dbAvailable || setupError) return;
      const exported = ids(section);
      expect(exported, `${section} lost the row that was NOT deleted`).toContain(live[key]);
      expect(exported, `${section} exported a row the user had deleted`).not.toContain(deleted[key]);
    });
  }

  it("matches what the already-correct domains do, which is the reason this is a defect", () => {
    if (!dbAvailable || setupError) return;
    // people/vehicles filtered deletedAt from the start. The five above sat in the same function, reading
    // the same kind of table for the same user, and did not.
    expect(ids("people")).toContain(personId);
    expect(ids("vehicles")).toContain(vehicleId);
  });
});
