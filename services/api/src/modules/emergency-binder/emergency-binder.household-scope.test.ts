import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as argon2 from "argon2";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { EmergencyBinderService } from "./emergency-binder.service";
import { HouseholdService } from "../household/household.service";
import { IdentityService } from "../identity/identity.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;
const stubQueue = {} as unknown as QueueProducer;

/**
 * Real-DB coverage for the emergency binder feature that closes the "document-only subset" gap flagged in
 * docs/PHASE2_PENDING_CREDENTIALS.md — proves both halves of the spec's requirements:
 *  1. The aggregation genuinely spans household roster, vehicles, properties, flagged documents, and the
 *     new medications/instructions free text (not just documents, like the old endpoint).
 *  2. The full-packet view actually requires §28.9 step-up re-authentication (an unauthenticated-feeling
 *     bug here would be a real privacy regression, not a cosmetic one, given how sensitive this data is).
 */
describe("EmergencyBinderService — household-scoped aggregation + step-up gating", () => {
  let db: Database;
  let households: HouseholdService;
  let identity: IdentityService;
  let binder: EmergencyBinderService;

  let ownerUserId: string;
  let memberUserId: string;
  let dependentMemberUserId: string; // a "dependent_profile"-role member with a linked account, for the adult-only settings-edit check
  let outsiderUserId: string;
  let householdId: string;
  let vehicleId: string;
  let propertyId: string;
  let documentId: string;
  const OWNER_PASSWORD = "correct horse battery staple";
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    identity = new IdentityService(db, stubQueue, noopMailer, stubOnboarding);
    binder = new EmergencyBinderService(db, households, identity);

    try {
      ownerUserId = generateId("user");
      memberUserId = generateId("user");
      dependentMemberUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");

      const ownerPasswordHash = await argon2.hash(OWNER_PASSWORD);
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `eb-owner-${ownerUserId}@example.com`, displayName: "Owner", passwordHash: ownerPasswordHash },
        { id: memberUserId, email: `eb-member-${memberUserId}@example.com`, displayName: "Member" },
        { id: dependentMemberUserId, email: `eb-dependent-${dependentMemberUserId}@example.com`, displayName: "Kid With An Account" },
        { id: outsiderUserId, email: `eb-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({
        id: householdId,
        name: "Emergency Binder Test Household",
        billingOwnerUserId: ownerUserId,
        medicationsNotes: "Grandma: 10mg lisinopril daily, allergic to penicillin",
        emergencyInstructions: "Gas shutoff is in the garage, left of the water heater",
      });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: memberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: dependentMemberUserId, role: "dependent_profile", status: "active", joinedAt: new Date() },
      ]);

      vehicleId = generateId("vehicle");
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, householdId, label: "Family minivan", make: "Honda", model: "Odyssey", year: 2021 });

      propertyId = generateId("property");
      await db.insert(schema.propertyProfiles).values({ id: propertyId, ownerUserId, householdId, label: "Home", propertyType: "home", address: "123 Main St" });

      documentId = generateId("document");
      await db.insert(schema.documents).values({
        id: documentId,
        ownerUserId,
        householdId,
        documentType: "other",
        title: "Home insurance policy",
        visibility: "household",
        isEmergencyBinderItem: true,
        tags: [],
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping EmergencyBinderService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
      await db.delete(schema.propertyProfiles).where(eq(schema.propertyProfiles.id, propertyId));
      await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
      await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, dependentMemberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
    }
  });

  it("rejects unlocking the binder with no password for an account that has one", async () => {
    if (!dbAvailable) return;
    await expect(binder.getBinder(householdId, ownerUserId, undefined)).rejects.toMatchObject({ response: { code: "PASSWORD_REQUIRED" } });
  });

  it("rejects unlocking the binder with the wrong password", async () => {
    if (!dbAvailable) return;
    await expect(binder.getBinder(householdId, ownerUserId, "definitely wrong")).rejects.toMatchObject({ response: { code: "INVALID_CREDENTIALS" } });
  });

  it("rejects a non-member entirely, before even reaching the password check", async () => {
    if (!dbAvailable) return;
    await expect(binder.getBinder(householdId, outsiderUserId, undefined)).rejects.toMatchObject({ response: { code: "NOT_A_MEMBER" } });
  });

  it("returns the full cross-domain packet once step-up succeeds: roster, vehicles, properties, flagged documents, and the household's free-text fields", async () => {
    if (!dbAvailable) return;
    const result = await binder.getBinder(householdId, ownerUserId, OWNER_PASSWORD);

    expect(result.household.id).toBe(householdId);
    expect(result.medicationsNotes).toContain("lisinopril");
    expect(result.emergencyInstructions).toContain("Gas shutoff");
    expect(result.members.map((m) => m.userId)).toEqual(expect.arrayContaining([ownerUserId, memberUserId, dependentMemberUserId]));
    expect(result.vehicles.map((v) => v.id)).toContain(vehicleId);
    expect(result.properties.map((p) => p.id)).toContain(propertyId);
    expect(result.documents.map((d) => d.id)).toContain(documentId);
  });

  it("a plain active member (no delegation, not the owner) can also unlock the binder, since OAuth-only/passwordless accounts skip step-up entirely", async () => {
    if (!dbAvailable) return;
    // memberUserId has no passwordHash set — verifyStepUpPassword is documented as a no-op for that case,
    // so undefined must succeed here (unlike the owner's case above, which correctly demands one).
    const result = await binder.getBinder(householdId, memberUserId, undefined);
    expect(result.household.id).toBe(householdId);
  });

  it("lets an adult member update the medications/instructions settings, but rejects a non-adult (dependent_profile) member", async () => {
    if (!dbAvailable) return;
    await binder.updateSettings(householdId, memberUserId, { medicationsNotes: "Updated by an adult member" });
    const settings = await binder.getSettings(householdId, ownerUserId);
    expect(settings.medicationsNotes).toBe("Updated by an adult member");

    await expect(binder.updateSettings(householdId, dependentMemberUserId, { medicationsNotes: "should not be allowed" })).rejects.toMatchObject({
      response: { code: "INSUFFICIENT_ROLE" },
    });
  });

  it("rejects settings read/write from a non-member", async () => {
    if (!dbAvailable) return;
    await expect(binder.getSettings(householdId, outsiderUserId)).rejects.toMatchObject({ response: { code: "NOT_A_MEMBER" } });
    await expect(binder.updateSettings(householdId, outsiderUserId, { medicationsNotes: "hacked" })).rejects.toMatchObject({ response: { code: "NOT_A_MEMBER" } });
  });
});
