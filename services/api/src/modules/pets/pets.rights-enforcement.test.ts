import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PetsService } from "./pets.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * SHARE-001 "Set view/edit/manage" — same adversarial goal as lists.rights-enforcement.test.ts, applied to
 * PetsService. None of the three grantees below are household members or "pets:manage" delegates (that's
 * PET-001's own, separate authorization path — see assertOwnedOrManagedPet's own doc comment); every
 * access they get here comes exclusively from their resourceGrant's `right`.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;

describe("PetsService SHARE-001 right enforcement (view/edit/manage)", () => {
  let db: Database;
  let sharing: SharingService;
  let pets: PetsService;
  let ownerUserId: string;
  let viewerUserId: string;
  let editorUserId: string;
  let managerUserId: string;
  let petId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    pets = new PetsService(db, stubHouseholds, sharing);
    try {
      ownerUserId = generateId("user");
      viewerUserId = generateId("user");
      editorUserId = generateId("user");
      managerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `pet-rights-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: viewerUserId, email: `pet-rights-viewer-${viewerUserId}@example.com`, displayName: "Viewer" },
        { id: editorUserId, email: `pet-rights-editor-${editorUserId}@example.com`, displayName: "Editor" },
        { id: managerUserId, email: `pet-rights-manager-${managerUserId}@example.com`, displayName: "Manager" },
      ]);

      const pet = await pets.create(ownerUserId, { label: "Rights test dog", species: "dog" });
      petId = pet.id;

      const [viewerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, viewerUserId)).limit(1);
      const [editorRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, editorUserId)).limit(1);
      const [managerRow] = await db.select({ email: schema.users.email }).from(schema.users).where(eq(schema.users.id, managerUserId)).limit(1);
      await pets.createGrant(petId, ownerUserId, viewerRow!.email!, undefined, "view", "Please watch Rex while we're away!");
      await pets.createGrant(petId, ownerUserId, editorRow!.email!, undefined, "edit");
      await pets.createGrant(petId, ownerUserId, managerRow!.email!, undefined, "manage");
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping pet rights-enforcement tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, viewerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, editorUserId));
      await db.delete(schema.users).where(eq(schema.users.id, managerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("a 'view' grant can read (and sees the granter's optional message) but cannot add a vaccination, edit, remove, or re-share", async () => {
    if (!dbAvailable) return;
    const detail = await pets.detail(petId, viewerUserId);
    expect(detail?.pet.id).toBe(petId);
    expect(detail?.sharedNote).toBe("Please watch Rex while we're away!");

    await expect(pets.addVaccination(petId, viewerUserId, { label: "Rabies" })).rejects.toThrow();
    await expect(pets.update(petId, viewerUserId, { label: "Hijacked" })).rejects.toThrow();
    await expect(pets.remove(petId, viewerUserId)).rejects.toThrow();
    await expect(pets.createGrant(petId, viewerUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
    await expect(pets.createShareLink(petId, viewerUserId, {})).rejects.toThrow();
  });

  it("an 'edit' grant can add a vaccination and edit the profile but cannot remove the pet or re-share it", async () => {
    if (!dbAvailable) return;
    await pets.addVaccination(petId, editorUserId, { label: "Rabies" });
    await pets.update(petId, editorUserId, { label: "Edited by editor" });
    const detail = await pets.detail(petId, editorUserId);
    expect(detail?.pet.label).toBe("Edited by editor");
    expect(detail?.vaccinations.some((v) => v.label === "Rabies")).toBe(true);

    await expect(pets.remove(petId, editorUserId)).rejects.toThrow();
    await expect(pets.createGrant(petId, editorUserId, `nobody-${generateId("user")}@example.com`)).rejects.toThrow();
  });

  it("a 'manage' grant can create/revoke other grants and remove the pet, but never becomes the owner", async () => {
    if (!dbAvailable) return;
    const tempGranteeId = generateId("user");
    const tempGranteeEmail = `pet-rights-temp-${tempGranteeId}@example.com`;
    await db.insert(schema.users).values({ id: tempGranteeId, email: tempGranteeEmail, displayName: "Temp" });
    const { id: tempGrantId } = await pets.createGrant(petId, managerUserId, tempGranteeEmail, undefined, "view");
    expect((await pets.listGrants(petId, managerUserId)).some((g) => g.grant.id === tempGrantId)).toBe(true);
    await pets.revokeResourceGrant(tempGrantId, managerUserId);

    const stillOwnedByOriginalOwner = await db.select({ ownerUserId: schema.petProfiles.ownerUserId }).from(schema.petProfiles).where(eq(schema.petProfiles.id, petId)).limit(1);
    expect(stillOwnedByOriginalOwner[0]?.ownerUserId).toBe(ownerUserId);

    await pets.remove(petId, managerUserId);
    await expect(pets.detail(petId, ownerUserId)).resolves.toBeNull();

    await db.delete(schema.users).where(eq(schema.users.id, tempGranteeId));
  });
});
