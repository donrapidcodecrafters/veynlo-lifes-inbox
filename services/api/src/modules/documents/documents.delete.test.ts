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
 * Phase 2 §52.2 "bulk management" surfaced that `documents.deletedAt` had existed since the table was
 * created but nothing ever wrote to or filtered on it — there was no way to delete a document at all. Real
 * DB test, same shape as documents.content-hash.test.ts: soft-delete must both hide the row from `list()`
 * and actually reject a `signedUrl` request for it, not just flip a column nothing reads.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubStorage = { putObject: async () => {}, getObject: async () => Buffer.alloc(0), signedGetUrl: async () => "https://example.com/signed" } as unknown as ObjectStorage;
const stubAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const allowingEntitlements = { assertStorageQuota: async () => {} } as unknown as EntitlementsService;

describe("DocumentsService.delete / bulkDelete", () => {
  let db: Database;
  let documents: DocumentsService;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    documents = new DocumentsService(db, stubStorage, stubAi, stubQueue, stubMalwareScanner, stubHouseholds, allowingEntitlements, new SharingService(db));
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `doc-delete-test-${ownerUserId}@example.com`, displayName: "Doc Delete Test" },
        { id: otherUserId, email: `doc-delete-test-${otherUserId}@example.com`, displayName: "Doc Delete Test Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping documents delete tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("soft-deletes: disappears from list() and signedUrl(), row survives with deletedAt set, and rejects a non-owner", async () => {
    if (!dbAvailable) return;
    const { documentId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "To be deleted",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("delete me"),
    });

    expect((await documents.list(ownerUserId)).some((d) => d.id === documentId)).toBe(true);
    await expect(documents.signedUrl(documentId, otherUserId)).rejects.toThrow();

    await expect(documents.delete(documentId, otherUserId)).rejects.toThrow(); // non-owner can't delete
    await documents.delete(documentId, ownerUserId);

    expect((await documents.list(ownerUserId)).some((d) => d.id === documentId)).toBe(false);
    await expect(documents.signedUrl(documentId, ownerUserId)).rejects.toThrow();

    const [row] = await db.select().from(schema.documents).where(eq(schema.documents.id, documentId));
    expect(row?.deletedAt).not.toBeNull();

    await db.delete(schema.documents).where(eq(schema.documents.id, documentId));
  });

  it("bulkDelete reports per-id success/failure instead of failing the whole batch on one bad id", async () => {
    if (!dbAvailable) return;
    const { documentId: goodId } = await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Bulk delete me",
      documentType: "other",
      mimeType: "text/plain",
      buffer: Buffer.from("bulk delete me"),
    });
    const notMineId = generateId("document");

    const result = await documents.bulkDelete([goodId, notMineId], ownerUserId);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toEqual([notMineId]);

    const [row] = await db.select({ deletedAt: schema.documents.deletedAt }).from(schema.documents).where(eq(schema.documents.id, goodId));
    expect(row?.deletedAt).not.toBeNull();

    await db.delete(schema.documents).where(eq(schema.documents.id, goodId));
  });
});
