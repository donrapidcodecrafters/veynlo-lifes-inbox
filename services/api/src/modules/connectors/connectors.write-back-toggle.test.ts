import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ConnectorsService } from "./connectors.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { IdentityService } from "../identity/identity.service";
import type { PlaidAdapter } from "./plaid.adapter";
import type { CredentialVault } from "../../common/credential-vault";

const stubQueue = { enqueueConnectorSync: async () => {}, enqueueConnectionDataDeletion: async () => {} } as unknown as QueueProducer;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * CAL-001 "write-back capability... requested only when user enables write-back" — proves the OFF-by-
 * default + scope-gated-ON contract at the service layer (ConnectorsController.setWriteBack is a thin
 * wrapper around this). The reconnect flow itself (authorizationUrl(writeBack:true) → OAuth round trip →
 * handleCallback granting the connection real write scope) can't be exercised here without a live Google/
 * Microsoft OAuth app — see docs/PHASE2_PENDING_CREDENTIALS.md — so this test proves the half that's fully
 * under this codebase's control: a connection whose `scopes` already contains the write scope (simulating
 * a completed reconnect) can be turned on, and one that doesn't cannot.
 */
describe("ConnectorsService.setWriteBack", () => {
  let db: Database;
  let connectors: ConnectorsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    connectors = new ConnectorsService(db, stubQueue, {} as IdentityService, {} as PlaidAdapter, {} as CredentialVault);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `write-back-toggle-${ownerUserId}@example.com`, displayName: "Toggle Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ConnectorsService.setWriteBack tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function makeConnection(scopes: string[]): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider: "google_calendar", feasibilityClass: "direct_api", scopes });
    return connectionId;
  }

  it("is OFF by default on a freshly connected calendar", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection(["https://www.googleapis.com/auth/calendar.readonly"]);
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.writeBackEnabled).toBe(false);
  });

  it("refuses to enable write-back when the connection only has readonly scope", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection(["https://www.googleapis.com/auth/calendar.readonly"]);
    await expect(connectors.setWriteBack(connectionId, ownerUserId, true)).rejects.toMatchObject({ response: { code: "WRITE_SCOPE_REQUIRED" } });
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.writeBackEnabled).toBe(false); // refusal doesn't half-apply the flag
  });

  it("enables write-back once the connection's scopes include the write scope (post-reconnect)", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection(["https://www.googleapis.com/auth/calendar"]);
    await connectors.setWriteBack(connectionId, ownerUserId, true);
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.writeBackEnabled).toBe(true);
  });

  it("always allows turning write-back back off, regardless of scope", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnection(["https://www.googleapis.com/auth/calendar"]);
    await connectors.setWriteBack(connectionId, ownerUserId, true);
    await connectors.setWriteBack(connectionId, ownerUserId, false);
    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.writeBackEnabled).toBe(false);
  });
});
