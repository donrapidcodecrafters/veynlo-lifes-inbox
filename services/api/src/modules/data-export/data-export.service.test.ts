import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { DataExportService } from "./data-export.service";

/** §54.2 launch criteria — real authorization test: a data export job (which links to a signed download
 * URL for the requesting user's own full data) must never be fetchable by anyone but its owner. */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
let dataExport: DataExportService;
const ownerId = generateId("user");
const strangerId = generateId("user");
const exportJobId = generateId("exportJob");

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  // downloadUrl()'s ForbiddenException path (the one under test) returns before touching queueProducer or
  // storage — only requestExport()'s and the completed-download's success paths need those real.
  dataExport = new DataExportService(db, {} as never, {} as never);
  await db.insert(schema.users).values([
    { id: ownerId, displayName: "Owner" },
    { id: strangerId, displayName: "Stranger" },
  ]);
  await db.insert(schema.exportJobs).values({
    id: exportJobId,
    ownerUserId: ownerId,
    state: "completed",
    storageKey: "exports/test/fake.json",
  });
});

afterAll(async () => {
  await db.delete(schema.exportJobs).where(inArray(schema.exportJobs.id, [exportJobId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [ownerId, strangerId]));
});

describe("DataExportService — cross-user isolation", () => {
  it("list() returns only the requesting user's own export jobs", async () => {
    const ownerJobs = await dataExport.list(ownerId);
    expect(ownerJobs.map((j) => j.id)).toEqual([exportJobId]);

    const strangerJobs = await dataExport.list(strangerId);
    expect(strangerJobs).toEqual([]);
  });

  it("downloadUrl() rejects a user who doesn't own the export job", async () => {
    await expect(dataExport.downloadUrl(exportJobId, strangerId)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
