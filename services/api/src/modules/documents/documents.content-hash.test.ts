import { createHash } from "node:crypto";
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
 * Phase 2 §52.2 cloud-file connectors — `findByContentHash` is the dedup check every
 * Drive/OneDrive/Dropbox adapter calls before importing a file a prior sync already pulled in. A real DB
 * integration test, same shape as ingestion.dedup.test.ts, since the interesting behavior is the actual
 * SQL join (scoped by owner, matched by hash) rather than anything mockable in isolation.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubStorage = { putObject: async () => {}, getObject: async () => Buffer.alloc(0) } as unknown as ObjectStorage;
const stubAi = { isConfigured: () => false } as unknown as ModelProvider;
const stubQueue = { enqueueDocumentOcr: async () => {} } as unknown as QueueProducer;
const stubMalwareScanner = { isConfigured: () => false } as unknown as MalwareScannerService;
const stubHouseholds = {} as unknown as HouseholdService;
const allowingEntitlements = { assertStorageQuota: async () => {} } as unknown as EntitlementsService;

describe("DocumentsService.findByContentHash", () => {
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
        { id: ownerUserId, email: `content-hash-test-${ownerUserId}@example.com`, displayName: "Content Hash Test" },
        { id: otherUserId, email: `content-hash-test-${otherUserId}@example.com`, displayName: "Content Hash Test Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping findByContentHash tests — no reachable dev Postgres:", (err as Error).message);
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

  it("is false before any matching upload, true after, and scoped per-owner", async () => {
    if (!dbAvailable) return;
    const buffer = Buffer.from(`unique drive file body ${generateId("document")}`, "utf8");
    const contentHash = createHash("sha256").update(buffer).digest("hex");

    expect(await documents.findByContentHash(ownerUserId, contentHash)).toBe(false);

    await documents.upload({
      ownerUserId,
      householdId: null,
      title: "Imported from Drive",
      documentType: "other",
      mimeType: "text/plain",
      buffer,
    });

    expect(await documents.findByContentHash(ownerUserId, contentHash)).toBe(true);
    // A different owner's dedup check must not see another user's imported file.
    expect(await documents.findByContentHash(otherUserId, contentHash)).toBe(false);
  });
});
