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
 * Phase 2 §52.2 "object sharing" (spec SHARE-001/SHARE-002) — real DB test for the two sharing paths:
 * a direct grant to another Veynlo account, and a passcode-gated public share link. Both are
 * security-relevant (an owner-check bypass or a passcode that doesn't actually gate access would be a
 * real vulnerability, not just a UX bug), so this exercises the actual grant/deny boundaries rather than
 * only the happy path.
 *
 * Rewritten for the SharingService extraction (see that module's own doc comment): DocumentsService no
 * longer owns the token/passcode mechanics directly — `accessShareLink` is now `SharingService.
 * resolveShareLink` (generic token/passcode validation) followed by `DocumentsService.publicShareContent`
 * (the document-specific redaction/rendering), same split PublicShareService uses in production.
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
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const allowingEntitlements = { assertStorageQuota: async () => {} } as unknown as EntitlementsService;

async function accessShareLink(sharing: SharingService, documents: DocumentsService, token: string, passcode: string | undefined) {
  const { resourceType, resourceId } = await sharing.resolveShareLink(token, passcode);
  expect(resourceType).toBe("document");
  return documents.publicShareContent(resourceId);
}

describe("DocumentsService object sharing", () => {
  let db: Database;
  let sharing: SharingService;
  let documents: DocumentsService;
  let ownerUserId: string;
  let granteeUserId: string;
  let granteeEmail: string;
  let strangerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    sharing = new SharingService(db);
    documents = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, stubHouseholds, allowingEntitlements, sharing);
    try {
      ownerUserId = generateId("user");
      granteeUserId = generateId("user");
      granteeEmail = `share-grantee-${granteeUserId}@example.com`;
      strangerUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `share-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: granteeUserId, email: granteeEmail, displayName: "Grantee" },
        { id: strangerUserId, email: `share-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping object sharing tests — no reachable dev Postgres:", (err as Error).message);
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
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Shared via grant",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("grant test"),
    });

    await expect(documents.signedUrl(documentId, strangerUserId)).rejects.toThrow();

    await expect(documents.createResourceGrant(documentId, strangerUserId, granteeEmail)).rejects.toThrow(); // non-owner can't grant
    const { id: grantId } = await documents.createResourceGrant(documentId, ownerUserId, granteeEmail);

    await expect(documents.signedUrl(documentId, granteeUserId)).resolves.toContain("https://example.com/signed/");
    expect((await documents.list(granteeUserId)).some((d) => d.id === documentId)).toBe(true);

    await documents.revokeResourceGrant(grantId, ownerUserId);
    await expect(documents.signedUrl(documentId, granteeUserId)).rejects.toThrow();
    expect((await documents.list(granteeUserId)).some((d) => d.id === documentId)).toBe(false);

    await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  });

  it("share link: wrong passcode is rejected, correct passcode grants a signed URL, and revoking invalidates the token", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Shared via link",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("link test"),
    });

    const { id: linkId, token } = await documents.createShareLink(documentId, ownerUserId, { passcode: "correct-horse" });

    await expect(sharing.resolveShareLink(token, undefined)).rejects.toThrow();
    await expect(sharing.resolveShareLink(token, "wrong-passcode")).rejects.toThrow();
    await expect(sharing.resolveShareLink("not-a-real-token", undefined)).rejects.toThrow();

    const result = await accessShareLink(sharing, documents, token, "correct-horse");
    expect(result.url).toContain("https://example.com/signed/");
    expect(result.title).toBe("Shared via link");

    await documents.revokeShareLink(linkId, ownerUserId);
    await expect(sharing.resolveShareLink(token, "correct-horse")).rejects.toThrow();

    await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  });

  it("createShareLink rejects highly_sensitive/secret documents, but createResourceGrant still works for them", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Sensitive doc",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("sensitive"),
    });
    await db.update(schema.documents).set({ sensitivity: "highly_sensitive" }).where(eq(schema.documents.id, documentId));

    await expect(documents.createShareLink(documentId, ownerUserId, {})).rejects.toThrow();
    await expect(documents.createResourceGrant(documentId, ownerUserId, granteeEmail)).resolves.toHaveProperty("id");

    await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  });
});
