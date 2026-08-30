import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { HouseholdService } from "../household/household.service";
import { SearchIndexService } from "../search/search-index.service";
import { SharingService } from "../shared/sharing.service";
import { RiskPolicyService } from "../intelligence/risk-policy.service";
import { DocumentsService } from "./documents.service";

/**
 * §HH-002 "object-level privacy badge" — same real gap as ScheduleService's identical fix: the
 * delegated-household read path already correctly excluded visibility:"private" documents, but nothing
 * anywhere ever set a document's visibility to anything else, so the caregiver-delegation feature
 * (documents:read) was functionally inert. Real DB-backed proof the new setVisibility mutation works.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const households = new HouseholdService(db, {} as never, {} as never);
const searchIndex = new SearchIndexService(db);
const sharing = new SharingService(db);
const documents = new DocumentsService(db, {} as never, {} as never, {} as never, households, sharing, searchIndex, {} as never, new RiskPolicyService(db));

const ownerId = generateId("user");
const strangerId = generateId("user");
const delegateId = generateId("user");
const memberId = generateId("user");
const householdId = generateId("household");
const docInHouseholdId = generateId("document");
const docSoloId = generateId("document");
const docPrivateId = generateId("document");
const delegationId = generateId("caregiverDelegation");

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
    { id: delegateId, displayName: "Delegate" },
    { id: memberId, displayName: "Household member" },
  ]);
  await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerId });
  await db.insert(schema.householdMemberships).values({ id: generateId("membership"), householdId, userId: memberId, role: "adult_member", status: "active" });
  await db.insert(schema.documents).values([
    { id: docInHouseholdId, ownerUserId: ownerId, householdId, documentType: "receipt", title: "Household doc", tags: [], visibility: "household" },
    { id: docSoloId, ownerUserId: ownerId, householdId: null, documentType: "receipt", title: "Solo doc", tags: [] },
    { id: docPrivateId, ownerUserId: ownerId, householdId, documentType: "receipt", title: "Private doc", tags: [], visibility: "private" },
  ]);
  await db.insert(schema.caregiverDelegations).values({
    id: delegationId,
    householdId,
    delegateUserId: delegateId,
    scopes: ["documents:read"],
    grantedByUserId: ownerId,
  });
});

afterAll(async () => {
  await db.delete(schema.resourceGrants).where(eq(schema.resourceGrants.resourceId, docPrivateId));
  await db.delete(schema.caregiverDelegations).where(eq(schema.caregiverDelegations.id, delegationId));
  await db.delete(schema.documents).where(inArray(schema.documents.id, [docInHouseholdId, docSoloId, docPrivateId]));
  await db.delete(schema.householdMemberships).where(eq(schema.householdMemberships.userId, memberId));
  await db.delete(schema.households).where(eq(schema.households.id, householdId));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId, delegateId, memberId]));
});

describe("DocumentsService.setVisibility", () => {
  it("refuses a stranger trying to change visibility on someone else's document", async () => {
    await expect(documents.setVisibility(docInHouseholdId, strangerId, "household")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses setting 'household' visibility on a document with no household at all", async () => {
    await expect(documents.setVisibility(docSoloId, ownerId, "household")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("the real owner can genuinely make a household document visible, then private again", async () => {
    await documents.setVisibility(docInHouseholdId, ownerId, "household");
    let [row] = await db.select({ visibility: schema.documents.visibility }).from(schema.documents).where(eq(schema.documents.id, docInHouseholdId));
    expect(row?.visibility).toBe("household");

    await documents.setVisibility(docInHouseholdId, ownerId, "private");
    [row] = await db.select({ visibility: schema.documents.visibility }).from(schema.documents).where(eq(schema.documents.id, docInHouseholdId));
    expect(row?.visibility).toBe("private");
    // Restore to "household" — the delegate-access tests below rely on this document being visible to them.
    await documents.setVisibility(docInHouseholdId, ownerId, "household");
  });
});

/**
 * Real, previously-shipped privilege-escalation bug: assertOwnedDocument (delegate-allowed, for genuine
 * reads) was ALSO used to gate every real mutation — delete, overwrite, retention (destroys the original
 * file), rename/retag, unlink, and worst of all mint a public share link — meaning a household member
 * granted only "documents:read" delegation could do all of that to another member's document. Fixed by
 * splitting into assertOwnedDocument (reads) vs. the new strict assertDocumentOwner (mutations). Real
 * DB-backed proof: a real caregiver_delegations row scoped to documents:read can read but not mutate.
 */
describe("DocumentsService — read-only delegate cannot mutate (privilege-escalation fix)", () => {
  it("a documents:read delegate CAN read version metadata (unchanged, correct behavior)", async () => {
    await expect(documents.listVersions(docInHouseholdId, delegateId)).resolves.toBeDefined();
  });

  it("a documents:read delegate CANNOT delete the document", async () => {
    await expect(documents.deleteDocument(docInHouseholdId, delegateId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a documents:read delegate CANNOT rename/retag it", async () => {
    await expect(documents.updateMetadata(docInHouseholdId, delegateId, { title: "Hijacked" })).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a documents:read delegate CANNOT change its retention policy (would destroy the original file)", async () => {
    await expect(documents.setRetention(docInHouseholdId, delegateId, "delete_after_processing")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a documents:read delegate CANNOT mint a public share link for it", async () => {
    await expect(documents.createShareLink(docInHouseholdId, delegateId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a documents:read delegate CANNOT unlink it from a resource", async () => {
    await expect(documents.unlinkResource(docInHouseholdId, delegateId, "purchase_fake")).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the real owner is completely unaffected by the fix", async () => {
    await expect(documents.updateMetadata(docInHouseholdId, ownerId, { title: "Household doc" })).resolves.toBeUndefined();
  });
});

/**
 * SHARE-001 "direct object sharing to a specific household member" — resource_grants existed and was read
 * by packages/authz/policy.ts but never written anywhere. Real DB-backed proof of the full loop against a
 * "private" document — household-wide delegation would NOT let this member in, so success here proves the
 * grant itself is what's doing the work, not some other access path.
 */
describe("DocumentsService — direct object grants (SHARE-001)", () => {
  it("refuses granting to someone who isn't an active household member", async () => {
    await expect(documents.shareWithMember(docPrivateId, ownerId, strangerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses granting to yourself", async () => {
    await expect(documents.shareWithMember(docPrivateId, ownerId, ownerId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a non-owner trying to grant access to their own document", async () => {
    await expect(documents.shareWithMember(docPrivateId, memberId, memberId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a household member with no grant cannot read the private document", async () => {
    await expect(documents.listVersions(docPrivateId, memberId)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("a real grant lets a specific member read an otherwise-private document, and revoking it removes access again", async () => {
    const { id: grantId } = await documents.shareWithMember(docPrivateId, ownerId, memberId);
    await expect(documents.listVersions(docPrivateId, memberId)).resolves.toBeDefined();

    const grants = await documents.listMemberGrants(docPrivateId, ownerId);
    expect(grants.map((g) => g.id)).toContain(grantId);

    await documents.revokeMemberAccess(docPrivateId, ownerId, grantId);
    await expect(documents.listVersions(docPrivateId, memberId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
