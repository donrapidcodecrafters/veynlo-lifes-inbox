import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PetsService } from "./pets.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = { delegatedHouseholdIds: async () => [], activeHouseholdIds: async () => [] } as unknown as HouseholdService;

/**
 * §40.1/40.2 "Entity Resolution" gap-close — pets previously had ZERO merge capability. §40.1's own
 * entity-resolution table has no row for pets (only Person/Purchase/Shipment/Subscription/Vehicle/Property/
 * Document/Trip are named), so PetsService.findPetMergeCandidates uses a judgment-call precision-first key
 * documented on petMergeKey's own doc comment: exact normalized name + exact household (or owner, with no
 * household) + exact species. This proves that key is genuinely precision-first (a different species is
 * never offered as a candidate even with an identical name), a confirmed merge combines vaccinations/
 * refill reminders/maintenance records/bills onto the surviving profile and fills gaps in on-profile fields
 * (microchip/vet/insurance info) without overwriting anything the survivor already had, and unmerge restores
 * the satellite rows exactly. Mirrors people.merge.test.ts's own shape.
 */
describe("PetsService — merge candidates and reversible merge/unmerge", () => {
  let db: Database;
  let sharing: SharingService;
  let pets: PetsService;

  let ownerUserId: string;
  let otherOwnerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    pets = new PetsService(db, stubHouseholds, sharing);

    try {
      ownerUserId = generateId("user");
      otherOwnerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `pet-merge-owner-${ownerUserId}@example.com`, displayName: "Pet Merge Owner" },
        { id: otherOwnerUserId, email: `pet-merge-other-${otherOwnerUserId}@example.com`, displayName: "Other Owner" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PetsService merge tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const owned = await db.select({ id: schema.petProfiles.id }).from(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, ownerUserId));
    for (const { id } of owned) {
      await db.delete(schema.petMergeLineage).where(eq(schema.petMergeLineage.survivingPetId, id));
      await db.delete(schema.petMergeLineage).where(eq(schema.petMergeLineage.mergedPetId, id));
      await db.delete(schema.petVaccinations).where(eq(schema.petVaccinations.petProfileId, id));
      await db.delete(schema.refillReminders).where(eq(schema.refillReminders.petProfileId, id));
      await db.delete(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.petProfileId, id));
      await db.delete(schema.bills).where(eq(schema.bills.petProfileId, id));
    }
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, ownerUserId));
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.ownerUserId, otherOwnerUserId));
    for (const id of [ownerUserId, otherOwnerUserId]) await db.delete(schema.users).where(eq(schema.users.id, id));
  });

  it("finds an exact name+household+species candidate group, but never a near-miss (different species, or a different name)", async () => {
    if (!dbAvailable) return;
    const { id: idA } = await pets.create(ownerUserId, { label: "Charlie", species: "dog" });
    const { id: idB } = await pets.create(ownerUserId, { label: "  charlie ", species: "Dog" }); // same name/species, different case/whitespace
    const { id: idC } = await pets.create(ownerUserId, { label: "Charlie", species: "cat" }); // same name, DIFFERENT species — must never be a candidate
    const { id: idD } = await pets.create(ownerUserId, { label: "Totally Unrelated", species: "dog" });

    const candidates = await pets.findPetMergeCandidates(ownerUserId);
    const group = candidates.find((c) => c.reason === "matching_name_household_and_species" && c.petIds.includes(idA));
    expect(group).toBeDefined();
    expect(group!.petIds.sort()).toEqual([idA, idB].sort());
    // Near-misses are correctly NOT offered.
    expect(candidates.some((c) => c.petIds.includes(idC))).toBe(false);
    expect(candidates.some((c) => c.petIds.includes(idD))).toBe(false);
  });

  it("mergePets repoints every satellite row onto the survivor, fills gaps in on-profile fields without overwriting, and is exactly reversed by unmergePets", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await pets.create(ownerUserId, { label: "Rex", species: "dog", vetProviderName: "Survivor Vet Clinic" });
    const { id: mergedId } = await pets.create(ownerUserId, { label: "Rex", species: "dog", insuranceProviderName: "Acme Pet Insurance", insurancePolicyNumber: "POL-123" });

    const vaccination = await pets.addVaccination(mergedId, ownerUserId, { label: "Rabies" });
    const refill = await pets.addRefillReminder(mergedId, ownerUserId, { medicationName: "Heartworm preventative", nextRefillDateIso: "2026-12-01" });
    const maintenance = await db.insert(schema.maintenanceRecords).values({ id: generateId("maintenanceRecord"), ownerUserId, petProfileId: mergedId, description: "Grooming" }).returning();
    const billId = generateId("bill");
    await db.insert(schema.bills).values({ id: billId, ownerUserId, petProfileId: mergedId, billerLabel: "Vet bill", dueDate: { precision: "date", instantUtc: null, date: "2026-11-01", timezone: null, sourceText: null } });

    const result = await pets.mergePets(survivorId, mergedId, ownerUserId);
    expect(result.repointedVaccinationCount).toBe(1);
    expect(result.repointedRefillReminderCount).toBe(1);
    expect(result.repointedMaintenanceRecordCount).toBe(1);
    expect(result.repointedBillCount).toBe(1);

    const [mergedRow] = await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, mergedId));
    expect(mergedRow!.mergedIntoPetId).toBe(survivorId);
    expect(mergedRow!.deletedAt).toBeNull();
    const list = await pets.list(ownerUserId);
    expect(list.map((p) => p.id)).not.toContain(mergedId);
    expect(list.map((p) => p.id)).toContain(survivorId);

    // On-profile fields: the survivor's own vetProviderName is preserved (never overwritten), while the
    // merged pet's insurance info — which the survivor didn't have — fills the gap.
    const [survivorAfter] = await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, survivorId));
    expect(survivorAfter!.vetProviderName).toBe("Survivor Vet Clinic");
    expect(survivorAfter!.insuranceProviderName).toBe("Acme Pet Insurance");
    expect(survivorAfter!.insurancePolicyNumber).toBe("POL-123");

    const [vaccinationAfter] = await db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.id, vaccination.id));
    expect(vaccinationAfter!.petProfileId).toBe(survivorId);
    const [refillAfter] = await db.select().from(schema.refillReminders).where(eq(schema.refillReminders.id, refill.id));
    expect(refillAfter!.petProfileId).toBe(survivorId);
    const [maintenanceAfter] = await db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, maintenance[0]!.id));
    expect(maintenanceAfter!.petProfileId).toBe(survivorId);
    const [billAfter] = await db.select().from(schema.bills).where(eq(schema.bills.id, billId));
    expect(billAfter!.petProfileId).toBe(survivorId);

    // --- Reverse it ---
    const restore = await pets.unmergePets(result.lineageId, ownerUserId);
    expect(restore.restoredVaccinationCount).toBe(1);
    expect(restore.restoredRefillReminderCount).toBe(1);
    expect(restore.restoredMaintenanceRecordCount).toBe(1);
    expect(restore.restoredBillCount).toBe(1);

    const [mergedRestored] = await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, mergedId));
    expect(mergedRestored!.mergedIntoPetId).toBeNull();
    const listAfterRestore = await pets.list(ownerUserId);
    expect(listAfterRestore.map((p) => p.id)).toContain(mergedId);

    const [vaccinationRestored] = await db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.id, vaccination.id));
    expect(vaccinationRestored!.petProfileId).toBe(mergedId);
    const [refillRestored] = await db.select().from(schema.refillReminders).where(eq(schema.refillReminders.id, refill.id));
    expect(refillRestored!.petProfileId).toBe(mergedId);
    const [maintenanceRestored] = await db.select().from(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, maintenance[0]!.id));
    expect(maintenanceRestored!.petProfileId).toBe(mergedId);
    const [billRestored] = await db.select().from(schema.bills).where(eq(schema.bills.id, billId));
    expect(billRestored!.petProfileId).toBe(mergedId);

    // Double-unmerge is rejected, not silently re-applied.
    await expect(pets.unmergePets(result.lineageId, ownerUserId)).rejects.toMatchObject({ response: { code: "ALREADY_UNMERGED" } });
  });

  it("rejects merging your own pet with one you don't own, and rejects merging a pet into itself", async () => {
    if (!dbAvailable) return;
    const { id: mineId } = await pets.create(ownerUserId, { label: "Mine" });
    const { id: theirsId } = await pets.create(otherOwnerUserId, { label: "Theirs" });
    await expect(pets.mergePets(mineId, theirsId, ownerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await expect(pets.mergePets(mineId, mineId, ownerUserId)).rejects.toMatchObject({ response: { code: "SAME_PET" } });
  });

  it("unmergePets rejects an actor who didn't perform the original merge", async () => {
    if (!dbAvailable) return;
    const { id: survivorId } = await pets.create(ownerUserId, { label: "Survivor 2", species: "cat" });
    const { id: mergedId } = await pets.create(ownerUserId, { label: "Survivor 2", species: "cat" });
    const { lineageId } = await pets.mergePets(survivorId, mergedId, ownerUserId);
    await expect(pets.unmergePets(lineageId, otherOwnerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
  });
});
