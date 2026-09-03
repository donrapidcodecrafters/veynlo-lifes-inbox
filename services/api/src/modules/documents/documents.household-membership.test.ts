import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { DocumentsService } from "./documents.service";
import { SharingService } from "../sharing/sharing.service";
import type { ObjectStorage } from "./object-storage.interface";
import type { ModelProvider } from "../intelligence/model-provider.interface";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MalwareScannerService } from "./malware-scanner.service";
import type { HouseholdService } from "../household/household.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";

/**
 * Real bug found via a live cross-service audit this session: `ownerOrDelegatedHousehold` (here and in
 * Commerce/Schedule/Lists/Assets) OR'd the row owner against `delegatedHouseholdIds` only — an explicit,
 * separate caregiver-delegation grant `acceptInvite` never creates. Plain active membership (what every
 * household member actually has the moment they join) was never checked, so a household-shared document
 * was invisible to every member except whoever uploaded it. This test exercises the fix: a plain member
 * (no delegation) must see a shared, non-private document in `list()` and be able to open its `signedUrl`,
 * while an outsider with neither membership nor delegation must not.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubStorage = {
  putObject: async () => {},
  getObject: async () => Buffer.alloc(0),
  signedGetUrl: async (blobRef: string) => `https://example.com/signed/${blobRef}`,
} as unknown as ObjectStorage;
const stubAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const allowingEntitlements = { assertStorageQuota: async () => {} } as unknown as EntitlementsService;

describe("DocumentsService household membership visibility", () => {
  let db: Database;
  let ownerUserId: string;
  let memberUserId: string;
  let outsiderUserId: string;
  let householdId: string;
  let documentId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      memberUserId = generateId("user");
      outsiderUserId = generateId("user");
      householdId = generateId("household");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `doc-hh-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: memberUserId, email: `doc-hh-member-${memberUserId}@example.com`, displayName: "Member" },
        { id: outsiderUserId, email: `doc-hh-outsider-${outsiderUserId}@example.com`, displayName: "Outsider" },
      ]);
      await db.insert(schema.households).values({ id: householdId, name: "Test Household", billingOwnerUserId: ownerUserId });

      documentId = generateId("document");
      await db.insert(schema.documents).values({
        id: documentId,
        ownerUserId,
        householdId,
        documentType: "other",
        title: "Shared lease agreement",
        visibility: "household",
        tags: [],
      });
      const versionId = generateId("documentVersion");
      await db.insert(schema.documentVersions).values({
        id: versionId,
        documentId,
        blobRef: `documents/${documentId}/v1.pdf`,
        contentHash: "test-hash",
        mimeType: "application/pdf",
        sizeBytes: 1024,
      });
      await db.update(schema.documents).set({ currentVersionId: versionId }).where(eq(schema.documents.id, documentId));
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DocumentsService household-membership tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, memberUserId));
      await db.delete(schema.users).where(eq(schema.users.id, outsiderUserId));
    }
  });

  it("a plain active household member (no delegation) sees a shared document; an outsider does not", async () => {
    if (!dbAvailable) return;
    const memberHouseholds = {
      delegatedHouseholdIds: async () => [],
      activeHouseholdIds: async (userId: string) => (userId === memberUserId ? [householdId] : []),
      isActiveMember: async (hhId: string, userId: string) => hhId === householdId && userId === memberUserId,
    } as unknown as HouseholdService;
    const outsiderHouseholds = {
      delegatedHouseholdIds: async () => [],
      activeHouseholdIds: async () => [],
      isActiveMember: async () => false,
    } as unknown as HouseholdService;

    const sharing = new SharingService(db);
    const memberDocs = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, memberHouseholds, allowingEntitlements, sharing);
    const outsiderDocs = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, outsiderHouseholds, allowingEntitlements, sharing);

    const memberList = await memberDocs.list(memberUserId);
    expect(memberList.map((d) => d.id)).toContain(documentId);

    const outsiderList = await outsiderDocs.list(outsiderUserId);
    expect(outsiderList.map((d) => d.id)).not.toContain(documentId);

    const memberUrl = await memberDocs.signedUrl(documentId, memberUserId);
    expect(memberUrl).toContain(documentId);

    await expect(outsiderDocs.signedUrl(documentId, outsiderUserId)).rejects.toThrow();
  });

  /**
   * HLTH-002 gap fix, found live: `documentDetail`/`signedUrl` both already carve `HEALTH_DOCUMENT_TYPES`
   * ("insurance_card", "eob") out of household-implied visibility — the spec's "remain private even inside
   * family plan" line — but `list()`'s own access condition (`ownerOrDelegatedHousehold`) didn't apply the
   * same carve-out, so a household member's insurance card/EOB metadata (title, type) showed up in
   * `GET /v1/documents` for every other member even though opening it correctly 403'd. This proves `list()`
   * now matches `documentDetail`/`signedUrl` exactly for a health-tagged document, even with
   * `visibility: "household"` — while an ordinary (non-health) household-shared document is unaffected.
   */
  it("a household member's insurance_card/eob document never appears in another member's list(), even at visibility 'household'", async () => {
    if (!dbAvailable) return;
    const memberHouseholds = {
      delegatedHouseholdIds: async () => [],
      activeHouseholdIds: async (userId: string) => (userId === memberUserId ? [householdId] : []),
      isActiveMember: async (hhId: string, userId: string) => hhId === householdId && userId === memberUserId,
    } as unknown as HouseholdService;
    const sharing = new SharingService(db);
    const ownerDocs = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, memberHouseholds, allowingEntitlements, sharing);
    const memberDocs = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, memberHouseholds, allowingEntitlements, sharing);

    const insuranceDocId = generateId("document");
    await db.insert(schema.documents).values({
      id: insuranceDocId,
      ownerUserId,
      householdId,
      documentType: "insurance_card",
      title: "Owner's insurance card",
      visibility: "household",
      tags: [],
    });

    try {
      const memberList = await memberDocs.list(memberUserId);
      expect(memberList.map((d) => d.id)).not.toContain(insuranceDocId);
      await expect(memberDocs.documentDetail(insuranceDocId, memberUserId)).rejects.toThrow();

      // The owner still sees it in their own list().
      const ownerList = await ownerDocs.list(ownerUserId);
      expect(ownerList.map((d) => d.id)).toContain(insuranceDocId);

      // An ordinary (non-health) household-shared document is unaffected by this carve-out.
      const memberListIds = memberList.map((d) => d.id);
      expect(memberListIds).toContain(documentId);
    } finally {
      await db.delete(schema.documents).where(eq(schema.documents.id, insuranceDocId));
    }
  });
});
