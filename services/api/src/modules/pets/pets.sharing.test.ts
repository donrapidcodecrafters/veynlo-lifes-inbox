import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PetsService } from "./pets.service";
import { SharingService } from "../sharing/sharing.service";
import type { HouseholdService } from "../household/household.service";

/**
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002), generalized onto pets exactly the way
 * AssetsService's identical properties/vehicles tests already cover — see assets.sharing.test.ts, which
 * this file mirrors structurally field-for-field.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => true,
} as unknown as HouseholdService;

describe("PetsService sharing", () => {
  let db: Database;
  let sharing: SharingService;
  let pets: PetsService;
  let ownerUserId: string;
  let granteeUserId: string;
  let granteeEmail: string;
  let strangerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    pets = new PetsService(db, stubHouseholds, sharing);
    try {
      ownerUserId = generateId("user");
      granteeUserId = generateId("user");
      granteeEmail = `pet-share-grantee-${granteeUserId}@example.com`;
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `pet-share-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: granteeUserId, email: granteeEmail, displayName: "Grantee" },
        { id: strangerUserId, email: `pet-share-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping pet sharing tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, granteeUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("resource grant: a stranger is denied, the grantee gains access, revoking removes it, and it shows up in the grantee's list()", async () => {
    if (!dbAvailable) return;
    const { id: petId } = await pets.create(ownerUserId, { label: "Rex", species: "Dog" });

    // Matches AssetsService.propertyDetail's own shape (see assets.sharing.test.ts's identical comment):
    // PetsService.detail throws (via assertPetAccess) for an unauthorized caller rather than returning null.
    await expect(pets.detail(petId, strangerUserId)).rejects.toThrow();
    await expect(pets.createGrant(petId, strangerUserId, granteeEmail)).rejects.toThrow(); // non-owner can't grant

    const { id: grantId } = await pets.createGrant(petId, ownerUserId, granteeEmail);

    const granteeDetail = await pets.detail(petId, granteeUserId);
    expect(granteeDetail?.pet.id).toBe(petId);
    expect((await pets.list(granteeUserId)).some((p) => p.id === petId)).toBe(true);

    await pets.revokeResourceGrant(grantId, ownerUserId);
    await expect(pets.detail(petId, granteeUserId)).rejects.toThrow();
    expect((await pets.list(granteeUserId)).some((p) => p.id === petId)).toBe(false);

    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
  });

  it("share link: a highly_sensitive pet is blocked from a public link (grants still work), and an ordinary pet's link resolves to a redacted public view omitting the microchip number", async () => {
    if (!dbAvailable) return;
    const { id: sensitivePetId } = await pets.create(ownerUserId, { label: "Vault Dog", microchipNumber: "985121000000000" });
    await db.update(schema.petProfiles).set({ sensitivity: "highly_sensitive" }).where(eq(schema.petProfiles.id, sensitivePetId));
    await expect(pets.createShareLink(sensitivePetId, ownerUserId, {})).rejects.toThrow();
    await expect(pets.createGrant(sensitivePetId, ownerUserId, granteeEmail)).resolves.toHaveProperty("id");

    const { id: petId } = await pets.create(ownerUserId, { label: "Rex", species: "Dog", breed: "Lab", microchipNumber: "985121000000001" });
    const { id: linkId, token } = await pets.createShareLink(petId, ownerUserId, {});

    const { resourceType, resourceId } = await sharing.resolveShareLink(token, undefined);
    expect(resourceType).toBe("pet");
    const content = await pets.publicPetContent(resourceId);
    expect(content.label).toBe("Rex");
    expect(content.breed).toBe("Lab");
    expect(content).not.toHaveProperty("microchipNumber");

    await pets.revokeShareLink(linkId, ownerUserId);
    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();

    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, sensitivePetId));
    await db.delete(schema.petProfiles).where(eq(schema.petProfiles.id, petId));
  });
});
