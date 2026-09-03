import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { DataExportService } from "./data-export.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { ObjectStorage } from "../documents/object-storage.interface";
import type { IdentityService } from "../identity/identity.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * `export_jobs.expiresAt` documents a stated 7-day retention window (see DataExportService's own doc
 * comment / `EXPORT_TTL_MS`), set by the worker on completion — but `downloadUrl` never read it, so a
 * signed URL to the full data export (purchases, bills, calendar events, document metadata, etc.) kept
 * working indefinitely past that window. Proves the fix: an expired export's download is refused.
 */
describe("DataExportService.downloadUrl — expiry enforcement", () => {
  let db: Database;
  let exportService: DataExportService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    exportService = new DataExportService(
      db,
      { enqueueDataExport: async () => {} } as unknown as QueueProducer,
      { signedGetUrl: async () => "https://signed.example/export.json" } as unknown as ObjectStorage,
      {} as IdentityService,
    );
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `export-expiry-${ownerUserId}@example.com`, displayName: "Export Expiry Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping DataExportService expiry test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.exportJobs).where(eq(schema.exportJobs.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("refuses to sign a download URL for a completed export past its expiresAt", async () => {
    if (!dbAvailable) return;
    const expiredId = generateId("exportJob");
    await db.insert(schema.exportJobs).values({
      id: expiredId,
      ownerUserId,
      state: "completed",
      storageKey: `exports/${ownerUserId}/${expiredId}.json`,
      completedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), // expired 3 days ago
    });

    await expect(exportService.downloadUrl(expiredId, ownerUserId)).rejects.toMatchObject({ response: { code: "EXPORT_EXPIRED" } });
  });

  it("still signs a download URL for a completed export within its expiry window", async () => {
    if (!dbAvailable) return;
    const freshId = generateId("exportJob");
    await db.insert(schema.exportJobs).values({
      id: freshId,
      ownerUserId,
      state: "completed",
      storageKey: `exports/${ownerUserId}/${freshId}.json`,
      completedAt: new Date(),
      expiresAt: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
    });

    await expect(exportService.downloadUrl(freshId, ownerUserId)).resolves.toEqual("https://signed.example/export.json");
  });
});
