import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PeopleService } from "./people.service";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../sharing/sharing.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { Cache } from "../../cache/cache.interface";
import type { MailerService } from "../notifications/mailer.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const noopCache: Cache = { incr: async () => 1, expire: async () => {} };
const noopMailer = { send: async () => {} } as unknown as MailerService;

/**
 * §14 "Contacts, People & Relationships" (PEO-001..005). Mirrors HealthLogisticsService's own adversarial
 * access-control matrix (health-logistics.access.test.ts): private-by-default is this domain's whole design
 * point (see PeopleService's own class doc comment), so a plain active household member must NEVER see a
 * still-private person just from membership alone — only an explicit "people:read" delegation on a row the
 * owner marked visibility:"household", or a direct resourceGrant, should ever open the door.
 */
describe("PeopleService — CRUD, relationship labels, and private-by-default access control", () => {
  let db: Database;
  let households: HouseholdService;
  let sharing: SharingService;
  let entitlements: EntitlementsService;
  let people: PeopleService;

  let ownerUserId: string;
  let plainMemberUserId: string;
  let delegateUserId: string; // holds "people:read"
  let granteeUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    entitlements = new EntitlementsService(db, noopCache);
    households = new HouseholdService(db, entitlements, noopMailer);
    sharing = new SharingService(db);
    people = new PeopleService(db, households, sharing);

    try {
      ownerUserId = generateId("user");
      plainMemberUserId = generateId("user");
      delegateUserId = generateId("user");
      granteeUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");

      await db.insert(schema.users).values([
        { id: ownerUserId, email: `peo-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: plainMemberUserId, email: `peo-member-${plainMemberUserId}@example.com`, displayName: "Plain Member" },
        { id: delegateUserId, email: `peo-delegate-${delegateUserId}@example.com`, displayName: "Delegate" },
        { id: granteeUserId, email: `peo-grantee-${granteeUserId}@example.com`, displayName: "Grantee" },
        { id: outsiderUserId, email: `peo-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "People Test Household", billingOwnerUserId: ownerUserId });
      await db.insert(schema.householdMemberships).values([
        { id: generateId("membership"), householdId, userId: ownerUserId, role: "household_owner", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: plainMemberUserId, role: "adult_member", status: "active", joinedAt: new Date() },
        { id: generateId("membership"), householdId, userId: delegateUserId, role: "adult_member", status: "active", joinedAt: new Date() },
      ]);
      await db.insert(schema.caregiverDelegations).values({
        id: generateId("caregiverDelegation"),
        householdId,
        delegateUserId,
        grantedByUserId: ownerUserId,
        scopes: ["people:read"],
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping PeopleService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.people).where(eq(schema.people.householdId, householdId));
    await db.delete(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.householdId, householdId));
    await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.householdId, householdId));
    await db.delete(schema.households).where(eq(schema.households.id, householdId));
    for (const id of [ownerUserId, plainMemberUserId, delegateUserId, granteeUserId, outsiderUserId]) {
      await db.delete(schema.users).where(eq(schema.users.id, id));
    }
  });

  it("creates a person private by default even when a householdId is given, with a manual contactSource", async () => {
    if (!dbAvailable) return;
    const { id } = await people.create(ownerUserId, { displayName: "Dr. Chen", householdId });
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, id));
    expect(row!.visibility).toBe("private");
    const sources = await db.select().from(schema.contactSources).where(eq(schema.contactSources.personId, id));
    expect(sources.map((s) => s.provider)).toContain("manual");
  });

  it("a plain active household member does NOT see a private person, even though the same household-visibility shape would grant them access to an ordinary shared object elsewhere in this app", async () => {
    if (!dbAvailable) return;
    const { id } = await people.create(ownerUserId, { displayName: "Private Friend", householdId });
    const list = await people.list(plainMemberUserId);
    expect(list.map((p) => p.id)).not.toContain(id);
    await expect(people.detail(id, plainMemberUserId)).rejects.toMatchObject({ response: { code: "NOT_AUTHORIZED" } });
  });

  it("a 'people:read' delegate sees a person only once the owner explicitly sets visibility:'household', never before", async () => {
    if (!dbAvailable) return;
    const { id } = await people.create(ownerUserId, { displayName: "Family Doctor", householdId });
    await expect(people.detail(id, delegateUserId)).rejects.toMatchObject({ response: { code: "NOT_AUTHORIZED" } });

    await people.setVisibility(id, ownerUserId, "household");
    const detail = await people.detail(id, delegateUserId);
    expect(detail.person.id).toBe(id);

    const list = await people.list(delegateUserId);
    expect(list.map((p) => p.id)).toContain(id);
  });

  it("setVisibility rejects a non-owner and requires a household before allowing 'household'", async () => {
    if (!dbAvailable) return;
    const { id } = await people.create(ownerUserId, { displayName: "Solo Contact" });
    await expect(people.setVisibility(id, plainMemberUserId, "household")).rejects.toMatchObject({ response: { code: "NOT_OWNER" } });
    await expect(people.setVisibility(id, ownerUserId, "household")).rejects.toMatchObject({ response: { code: "HOUSEHOLD_REQUIRED" } });
  });

  it("an explicit resourceGrant recipient sees exactly the one person shared with them, and nothing else", async () => {
    if (!dbAvailable) return;
    const { id: sharedId } = await people.create(ownerUserId, { displayName: "Shared Contact" });
    const { id: otherId } = await people.create(ownerUserId, { displayName: "Ungranted Contact" });
    await people.createGrant(sharedId, ownerUserId, `peo-grantee-${granteeUserId}@example.com`);
    const list = await people.list(granteeUserId);
    expect(list.map((p) => p.id)).toContain(sharedId);
    expect(list.map((p) => p.id)).not.toContain(otherId);
  });

  it("an outsider (no membership, delegation, or grant) is fully blocked", async () => {
    if (!dbAvailable) return;
    const { id } = await people.create(ownerUserId, { displayName: "Outsider Test Contact", householdId });
    await people.setVisibility(id, ownerUserId, "household");
    const list = await people.list(outsiderUserId);
    expect(list.map((p) => p.id)).not.toContain(id);
    await expect(people.detail(id, outsiderUserId)).rejects.toMatchObject({ response: { code: "NOT_AUTHORIZED" } });
  });

  it("PEO-003: relationship labels are user-editable and a 'suggested' label must be explicitly confirmed, never silently promoted", async () => {
    if (!dbAvailable) return;
    const { id: orgId } = await people.createOrganization(ownerUserId, { name: "Smile Dental", organizationType: "dental" });
    // No relationshipLabel given — organizationType "dental" triggers ONLY a suggestion, never an applied label.
    const { id } = await people.create(ownerUserId, { displayName: "Dr. Lee", organizationId: orgId });
    let [row] = await db.select().from(schema.people).where(eq(schema.people.id, id));
    expect(row!.relationshipLabel).toBe("dentist");
    expect(row!.relationshipLabelSource).toBe("suggested");

    // Confirming promotes it to user_set without changing the text.
    await people.confirmSuggestedRelationshipLabel(id, ownerUserId);
    [row] = await db.select().from(schema.people).where(eq(schema.people.id, id));
    expect(row!.relationshipLabel).toBe("dentist");
    expect(row!.relationshipLabelSource).toBe("user_set");

    // Confirming again (nothing left to confirm) is rejected, not a silent no-op.
    await expect(people.confirmSuggestedRelationshipLabel(id, ownerUserId)).rejects.toMatchObject({ response: { code: "NO_SUGGESTION" } });

    // A direct edit always lands as user_set.
    await people.setRelationshipLabel(id, ownerUserId, "family dentist");
    [row] = await db.select().from(schema.people).where(eq(schema.people.id, id));
    expect(row!.relationshipLabel).toBe("family dentist");
    expect(row!.relationshipLabelSource).toBe("user_set");
  });

  it("a user-supplied relationshipLabel always wins over any organization-type suggestion", async () => {
    if (!dbAvailable) return;
    const { id: orgId } = await people.createOrganization(ownerUserId, { name: "Downtown Medical", organizationType: "medical" });
    const { id } = await people.create(ownerUserId, { displayName: "Dr. Patel", organizationId: orgId, relationshipLabel: "pediatrician" });
    const [row] = await db.select().from(schema.people).where(eq(schema.people.id, id));
    expect(row!.relationshipLabel).toBe("pediatrician");
    expect(row!.relationshipLabelSource).toBe("user_set");
  });

  it("PEO-004: linking a related entity requires the entity to actually belong to the same owner", async () => {
    if (!dbAvailable) return;
    const { id: personId } = await people.create(ownerUserId, { displayName: "Handyman" });
    const foreignMaintenanceId = generateId("maintenanceRecord");
    await db.insert(schema.maintenanceRecords).values({
      id: foreignMaintenanceId,
      ownerUserId: outsiderUserId, // NOT this person's owner
      description: "Not yours",
      serviceDate: { precision: "date", instantUtc: null, date: "2026-01-01", timezone: null, sourceText: null },
    });
    await expect(people.linkEntity(personId, ownerUserId, foreignMaintenanceId)).rejects.toMatchObject({ response: { code: "NOT_YOUR_ITEM" } });

    const ownMaintenanceId = generateId("maintenanceRecord");
    await db.insert(schema.maintenanceRecords).values({
      id: ownMaintenanceId,
      ownerUserId,
      description: "Fixed the sink",
      serviceDate: { precision: "date", instantUtc: null, date: "2026-01-01", timezone: null, sourceText: null },
    });
    await people.linkEntity(personId, ownerUserId, ownMaintenanceId);
    const detail = await people.detail(personId, ownerUserId);
    expect((detail.linkedHistory.maintenanceRecord as { id: string }[]).map((m) => m.id)).toContain(ownMaintenanceId);

    await people.unlinkEntity(personId, ownerUserId, ownMaintenanceId);
    const [refreshed] = await db.select().from(schema.people).where(eq(schema.people.id, personId));
    expect(refreshed!.relatedEntityIds).not.toContain(ownMaintenanceId);

    await db.delete(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, foreignMaintenanceId));
    await db.delete(schema.maintenanceRecords).where(eq(schema.maintenanceRecords.id, ownMaintenanceId));
  });

  it("PEO-005: an important date marked isSensitive is hidden from a non-owner even when the person itself is household-visible", async () => {
    if (!dbAvailable) return;
    const { id } = await people.create(ownerUserId, { displayName: "Shared Provider", householdId });
    await people.setVisibility(id, ownerUserId, "household");
    await people.addImportantDate(id, ownerUserId, { label: "Private note date", dateIso: "2026-05-01", isSensitive: true });
    await people.addImportantDate(id, ownerUserId, { label: "Office anniversary", dateIso: "2026-06-01", isSensitive: false });

    const ownerView = await people.detail(id, ownerUserId);
    expect(ownerView.importantDates.map((d) => d.label)).toEqual(expect.arrayContaining(["Private note date", "Office anniversary"]));

    const delegateView = await people.detail(id, delegateUserId);
    expect(delegateView.importantDates.map((d) => d.label)).not.toContain("Private note date");
    expect(delegateView.importantDates.map((d) => d.label)).toContain("Office anniversary");
  });
});
