import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PetsService } from "./pets.service";
import { AssetsService } from "../assets/assets.service";
import { SharingService } from "../sharing/sharing.service";
import { HouseholdService } from "../household/household.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { EmergencyBinderService } from "../emergency-binder/emergency-binder.service";
import type { IdentityService } from "../identity/identity.service";
import type { RecallMonitorService } from "../assets/recall-monitor.service";
import type { VinDecodeService } from "../assets/vin-decode.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubRecallMonitor = {} as unknown as RecallMonitorService;
const stubVinDecode = {} as unknown as VinDecodeService;
const stubQueue = { enqueueRecallCheck: async () => {} } as unknown as QueueProducer;
// EmergencyBinderService's step-up check is exercised on its own in emergency-binder.household-scope.test.ts
// — this file only needs getBinder() to run at all, so verifyStepUpPassword is a no-op here.
const stubIdentity = { verifyStepUpPassword: async () => {} } as unknown as IdentityService;

/**
 * Real-DB household-scope coverage for PET-001..PET-005, mirroring emergency-binder.household-scope.test.ts's
 * real-HouseholdService pattern (not a stub) — proves the actual FAM-006 household-visibility bug class
 * (repeated this session — see ScheduleService/AssetsService/CommerceService's own ownerOrDelegatedHousehold
 * doc comments) doesn't recur for pets: a plain household member (no explicit grant) sees a household-owned
 * pet, an outsider does not, and the emergency binder's own pet aggregation reflects the same household scope.
 */
describe("PetsService — household-scoped visibility + sub-resources", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let pets: PetsService;
  let assets: AssetsService;
  let binder: EmergencyBinderService;

  let ownerUserId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let petId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    pets = new PetsService(db, households, sharing);
    assets = new AssetsService(db, households, sharing, stubRecallMonitor, stubVinDecode, stubQueue);
    binder = new EmergencyBinderService(db, households, stubIdentity);

    try {
      ownerUserId = generateId("user");
      memberUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");

      await db.insert(schema.users).values([
        { id: ownerUserId, email: `pet-hh-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: memberUserId, email: `pet-hh-member-${memberUserId}@example.com`, displayName: "Member" },
        { id: outsiderUserId, email: `pet-hh-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Pets Test Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);

      const created = await pets.create(ownerUserId, { label: "Rex", species: "Dog", breed: "Lab", householdId });
      petId = created.id;
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping pets household-scope tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      if (petId) await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("a household member (no explicit grant) sees the household-owned pet; an outsider does not", async () => {
    if (!dbAvailable) return;
    expect((await pets.list(memberUserId)).some((p) => p.id === petId)).toBe(true);
    await expect(pets.detail(petId, memberUserId)).resolves.toHaveProperty("pet.id", petId);

    expect((await pets.list(outsiderUserId)).some((p) => p.id === petId)).toBe(false);
    await expect(pets.detail(petId, outsiderUserId)).rejects.toThrow();
  });

  it("PET-004 vaccination add + conservative assign flow, and PET-004's 'sourced/user-confirmed' promotion boundary", async () => {
    if (!dbAvailable) return;
    // A household member (not just the owner) can add a vaccination record — PET-001's "configurable
    // household managers", same household-shared-write posture as AssetsService.createMaintenanceRecord.
    const { id: vaccinationId } = await pets.addVaccination(petId, memberUserId, { label: "Rabies", expirationDateIso: "2027-01-01" });
    const [row] = await db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.id, vaccinationId));
    expect(row?.source).toBe("user_confirmed"); // manual add is confirmed on arrival — see addVaccination's own doc comment

    // assignVaccination is the "let the user assign" half of extractPetVaccination's conservative matching —
    // exercised directly here since it's the same code path an unassigned evidence-sourced candidate uses.
    await pets.assignVaccination(vaccinationId, petId, memberUserId);
    const [reassigned] = await db.select().from(schema.petVaccinations).where(eq(schema.petVaccinations.id, vaccinationId));
    expect(reassigned?.petProfileId).toBe(petId);

    const outsiderPet = await pets.create(outsiderUserId, { label: "Someone Else's Cat" });
    await expect(pets.assignVaccination(vaccinationId, outsiderPet.id, outsiderUserId)).rejects.toThrow();
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, outsiderPet.id));
  });

  it("PET-003 refill reminders: add, mark picked up, roll the date forward, and the pets-only access boundary against a dependent-scoped row", async () => {
    if (!dbAvailable) return;
    const { id: reminderId } = await pets.addRefillReminder(petId, ownerUserId, { medicationName: "Heartworm chewable", nextRefillDateIso: "2026-10-01", pharmacy: "Corner Pharmacy" });
    await pets.markRefillPickedUp(reminderId, ownerUserId);
    let [reminder] = await db.select().from(schema.refillReminders).where(eq(schema.refillReminders.id, reminderId));
    expect(reminder?.pickedUpAt).not.toBeNull();

    await pets.markRefillHandled(reminderId, ownerUserId, "2026-11-01");
    [reminder] = await db.select().from(schema.refillReminders).where(eq(schema.refillReminders.id, reminderId));
    expect(reminder?.nextRefillDateSort?.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(reminder?.pickedUpAt).toBeNull(); // a new cycle starts unhandled — see markRefillHandled's own doc comment

    // The shared refillReminders table's other half (dependentProfileId set, petProfileId null) must be
    // unreachable through the pets endpoint surface even for the row's own owner — see
    // PetsService.loadOwnedRefillReminder's own doc comment on why this is a hard reject, not an implicit
    // owner-match allow.
    const dependentScopedId = generateId("refillReminder");
    await db.insert(schema.refillReminders).values({
      id: dependentScopedId,
      ownerUserId,
      petProfileId: null,
      medicationName: "Human family member's medication",
      nextRefillDate: { precision: "date", instantUtc: null, date: "2026-10-15", timezone: null, sourceText: null },
    });
    await expect(pets.markRefillPickedUp(dependentScopedId, ownerUserId)).rejects.toThrow();
    await db.delete(schema.refillReminders).where(eq(schema.refillReminders.id, dependentScopedId));

    await db.delete(schema.refillReminders).where(eq(schema.refillReminders.id, reminderId));
  });

  it("PET-005: a vet-visit maintenance record added via the shared AssetsService/maintenance-records path shows up in pets.detail()", async () => {
    if (!dbAvailable) return;
    const { id: recordId } = await assets.createMaintenanceRecord(memberUserId, { description: "Annual checkup", petProfileId: petId, costMinorUnits: 8500, costCurrency: "USD" });
    const detail = await pets.detail(petId, ownerUserId);
    expect(detail?.maintenance.some((m) => m.id === recordId)).toBe(true);
    await db.delete(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, recordId));
  });

  it("the emergency binder's household aggregation includes this pet", async () => {
    if (!dbAvailable) return;
    const aggregated = await binder.getBinder(householdId, ownerUserId, undefined);
    expect(aggregated.pets.some((p) => p.id === petId)).toBe(true);
  });

  /**
   * PET-001 "configurable household managers" — found live (spec: "Pet is a household entity with
   * configurable managers" / user action "assign household manager") that `update`/`remove` were hard
   * `ownerUserId === userId` checks with no way to configure a manager at all, unlike every sub-resource
   * write above (vaccinations/refill reminders), which a plain household member could already do. Fixed by
   * reusing the existing caregiver-delegation mechanism with a new "pets:manage" scope — this proves a
   * plain member (no delegation) still can't edit/remove another member's pet, a member holding a
   * "pets:manage" delegation for this household CAN, and revoking that delegation immediately takes the
   * ability away again (mirrors HouseholdService.delegatedHouseholdIds' own post-leave revocation guarantee
   * for every other domain's delegation).
   */
  it("PET-001: 'pets:manage' delegation lets a non-owner household member edit/remove a pet; plain membership alone still can't", async () => {
    if (!dbAvailable) return;
    const managerUserId = generateId("user");
    await db.insert(schema.users).values({ id: managerUserId, email: `pet-hh-manager-${managerUserId}@example.com`, displayName: "Manager" });
    await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: managerUserId, role: "adult_member", status: "active", joinedAt: new Date() });

    const managedPet = await pets.create(ownerUserId, { label: "Fido", householdId });

    // Plain active membership (memberUserId, no delegation) is NOT enough to edit or remove — this is the
    // exact gap PET-001 calls out, still true for anyone without an explicit manager grant.
    await expect(pets.update(managedPet.id, memberUserId, { label: "Renamed by non-manager" })).rejects.toThrow();
    await expect(pets.remove(managedPet.id, memberUserId)).rejects.toThrow();

    const { id: delegationId } = await households.grantDelegation(householdId, ownerUserId, { delegateUserId: managerUserId, scopes: ["pets:manage"] });

    await pets.update(managedPet.id, managerUserId, { label: "Renamed by manager" });
    const [updated] = await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, managedPet.id));
    expect(updated?.label).toBe("Renamed by manager");

    await households.revokeDelegation(householdId, delegationId, ownerUserId);
    await expect(pets.update(managedPet.id, managerUserId, { label: "Should be denied now" })).rejects.toThrow();

    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, managedPet.id));
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.userId, managerUserId));
    await db.delete(schema.users).where(eq(schema.users.id, managerUserId));
  });

  /**
   * Gap-close: a pet created private (no householdId) never showed up in its owner's household Emergency
   * Binder — confirmed live, and structurally identical to the assets.household-assignment.test.ts vehicle/
   * property cases (see that file's own doc comment). `update` now accepts `householdId`
   * (UpdatePetProfileDtoSchema's own doc comment); this proves the full loop end to end against the REAL
   * EmergencyBinderService, not just that the DTO field is accepted.
   */
  it("assigning householdId via update() makes a previously-private pet show up in the emergency binder; unassigning removes it again", async () => {
    if (!dbAvailable) return;
    const privatePet = await pets.create(ownerUserId, { label: "Private Cat", species: "Cat" });
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).pets.some((p) => p.id === privatePet.id)).toBe(false);

    await pets.update(privatePet.id, ownerUserId, { householdId });
    const [afterAssign] = await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, privatePet.id));
    expect(afterAssign?.householdId).toBe(householdId);
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).pets.some((p) => p.id === privatePet.id)).toBe(true);

    // A member of a DIFFERENT household can't assign someone else's pet into it.
    const otherHouseholdId = generateId("household");
    await db.insert(schema.households).values({ id: otherHouseholdId, name: "Someone Else's Household", billingOwnerUserId: outsiderUserId });
    await expect(pets.update(privatePet.id, ownerUserId, { householdId: otherHouseholdId })).rejects.toThrow();

    // Explicit null makes it private again — removed from the binder.
    await pets.update(privatePet.id, ownerUserId, { householdId: null });
    const [afterUnassign] = await db.select().from(schema.petProfiles).where(eq(schema.petProfiles.id, privatePet.id));
    expect(afterUnassign?.householdId).toBeNull();
    expect((await binder.getBinder(householdId, ownerUserId, undefined)).pets.some((p) => p.id === privatePet.id)).toBe(false);

    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, privatePet.id));
    await db.delete(schema.households).where(eq(schema.households.id, otherHouseholdId));
  });
});
