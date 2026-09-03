import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PetsService } from "./pets.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => true,
} as unknown as HouseholdService;

/**
 * AI-001 "Evidence-backed fact creation" — found live during an audit pass: petVaccinations.sourceEventId
 * has been populated by extractPetVaccination since that extractor shipped, but PetsService.detail never
 * read it back — the identical gap this session's health-appointment evidence fix closed. Mirrors
 * health-logistics.service.test.ts's equivalent evidence-round-trip case.
 */
describe("PetsService.detail — evidence citation for discovered vaccinations", () => {
  let db: Database;
  let sharing: SharingService;
  let pets: PetsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    pets = new PetsService(db, stubHouseholds, sharing);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `pet-evidence-${ownerUserId}@example.com`, displayName: "Pet Evidence Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PetsService evidence test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  it("attaches real source-event evidence to a discovered vaccination, and null for a manually-added one", async () => {
    if (!dbAvailable) return;
    const petId = generateId("pet");
    await db.insert(schema.petProfiles).values({ id: petId, ownerUserId, label: "Test Dog" });

    const sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email_message",
      contentHash: "test-hash",
      occurredAt: new Date(),
      idempotencyKey: `pet-evidence-test-${sourceEventId}`,
      processingState: "needs_review",
      subjectLine: "Your dog's rabies vaccination is due",
      fromAddress: "reminders@vetclinic.example.com",
      snippet: "Fido is due for a rabies booster next month.",
    });

    const discoveredVaccinationId = generateId("petVaccination");
    const manualVaccinationId = generateId("petVaccination");
    await db.insert(schema.petVaccinations).values([
      { id: discoveredVaccinationId, ownerUserId, petProfileId: petId, label: "Rabies", source: "evidence_sourced", sourceEventId },
      { id: manualVaccinationId, ownerUserId, petProfileId: petId, label: "City license", source: "user_confirmed" },
    ]);

    const detail = await pets.detail(petId, ownerUserId);
    expect(detail).toBeTruthy();
    const discovered = detail!.vaccinations.find((v) => v.id === discoveredVaccinationId);
    const manual = detail!.vaccinations.find((v) => v.id === manualVaccinationId);

    expect(discovered?.evidence).toBeTruthy();
    expect(discovered!.evidence!.subjectLine).toBe("Your dog's rabies vaccination is due");
    expect(discovered!.evidence!.fromAddress).toBe("reminders@vetclinic.example.com");

    expect(manual?.evidence).toBeNull();

    await db.delete(schema.petVaccinations).where(eq(schema.petVaccinations.petProfileId, petId));
    await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.id, sourceEventId));
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
  });
});
