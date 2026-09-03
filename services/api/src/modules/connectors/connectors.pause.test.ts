import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ConnectorsService } from "./connectors.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { IdentityService } from "../identity/identity.service";
import type { PlaidAdapter } from "./plaid.adapter";
import type { CredentialVault } from "../../common/credential-vault";

const stubQueue = {} as unknown as QueueProducer;
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * PRIV-001 "pause a connection's processing without fully disconnecting it" — proves the actual
 * enforcement point: `ConnectorsService.listEligibleForIncrementalScan` (worker-main.ts's
 * connectorScanWorker calls exactly this, unmodified, on its recurring tick — extracted specifically so it
 * could be tested here without spinning up a real BullMQ/Redis worker). A paused connection must be
 * excluded from every future incremental-sync scan tick — i.e. "genuinely does nothing" — while an
 * unpaused, otherwise-healthy one is included, and resuming a paused connection makes it eligible again.
 */
describe("ConnectorsService — pause excludes a connection from incremental scan", () => {
  let db: Database;
  let connectors: ConnectorsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    connectors = new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `pause-test-${ownerUserId}@example.com`, displayName: "Pause Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ConnectorsService pause tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  async function makeConnection(overrides: Partial<typeof schema.connections.$inferInsert> = {}): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider: "gmail",
      feasibilityClass: "direct_api",
      health: "healthy",
      ...overrides,
    });
    return connectionId;
  }

  it("is not paused by default on a freshly connected, healthy connection, and is eligible for the incremental scan", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection();
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.paused).toBe(false);
    const eligible = await connectors.listEligibleForIncrementalScan();
    expect(eligible.map((c) => c.id)).toContain(connectionId);
  });

  it("setPaused(true) excludes an otherwise-healthy connection from the incremental-scan eligibility list", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection();
    await connectors.setPaused(connectionId, ownerUserId, true);

    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.paused).toBe(true);
    expect(row?.pausedAt).not.toBeNull();
    // Pausing must not touch health/credentials/disconnectedAt — it's reversible and non-destructive.
    expect(row?.health).toBe("healthy");
    expect(row?.disconnectedAt).toBeNull();

    const eligible = await connectors.listEligibleForIncrementalScan();
    expect(eligible.map((c) => c.id)).not.toContain(connectionId);
  });

  it("setPaused(false) makes a previously-paused connection eligible again", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection();
    await connectors.setPaused(connectionId, ownerUserId, true);
    expect((await connectors.listEligibleForIncrementalScan()).map((c) => c.id)).not.toContain(connectionId);

    await connectors.setPaused(connectionId, ownerUserId, false);
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.paused).toBe(false);
    expect(row?.pausedAt).toBeNull();
    expect((await connectors.listEligibleForIncrementalScan()).map((c) => c.id)).toContain(connectionId);
  });

  it("a paused connection stays excluded from the scan regardless of provider (gmail, calendar, drive, etc.)", async () => {
    if (!dbAvailable) return;
    const providers = ["gmail", "outlook", "google_calendar", "google_drive", "plaid"];
    const connectionIds: string[] = [];
    for (const provider of providers) {
      const id = await makeConnection({ provider });
      await connectors.setPaused(id, ownerUserId, true);
      connectionIds.push(id);
    }
    const eligible = await connectors.listEligibleForIncrementalScan();
    const eligibleIds = new Set(eligible.map((c) => c.id));
    for (const id of connectionIds) {
      expect(eligibleIds.has(id)).toBe(false);
    }
  });
});
