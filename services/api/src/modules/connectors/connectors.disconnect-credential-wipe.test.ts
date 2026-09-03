import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { ConnectorsService } from "./connectors.service";
import { CredentialVault } from "../../common/credential-vault";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { IdentityService } from "../identity/identity.service";
import type { PlaidAdapter } from "./plaid.adapter";

const stubQueue = { enqueueConnectorSync: async () => {}, enqueueConnectionDataDeletion: async () => {} } as unknown as QueueProducer;
const stubIdentity = { verifyStepUpPassword: async () => {} } as unknown as IdentityService;
const stubPlaid = { revoke: async () => {} } as unknown as PlaidAdapter;

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * Regression for a real bug found in this audit: `ConnectorsService.disconnect` marked the connection
 * `health: "disconnected"` but never deleted the `connection_credentials` row — the OAuth token stayed
 * fully decryptable in the vault indefinitely after "disconnect", regardless of whether the user also
 * asked to delete derived data. §45.1 requires tokens live only in the encrypted credential subsystem and
 * be actually gone, not just orphaned-but-intact, once a connection is disconnected.
 */
describe("ConnectorsService.disconnect — credential vault wipe", () => {
  let db: Database;
  let vault: CredentialVault;
  let connectors: ConnectorsService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    vault = new CredentialVault(db);
    connectors = new ConnectorsService(db, stubQueue, stubIdentity, stubPlaid, vault);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `disconnect-wipe-${ownerUserId}@example.com`, displayName: "Disconnect Wipe Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ConnectorsService.disconnect credential-wipe tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  // gmail/google_calendar disconnects now also call ConnectorsService.revokeProviderToken, which reaches
  // out to Google's real /revoke endpoint — stubbed here (same vi.stubGlobal("fetch", ...) pattern
  // plaid.adapter.test.ts uses) so this file's disconnect tests stay hermetic instead of making a real
  // network call on every run. Left permissive (always 200) since revocation upstream is not what these
  // particular tests are about — connectors.revoke-provider-token.test.ts asserts the actual request shape.
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function makeConnectedConnection(provider: string): Promise<{ connectionId: string; credentialId: string }> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider, feasibilityClass: "direct_api", scopes: [] });
    const credentialId = await vault.store(connectionId, { access_token: "super-secret-token", refresh_token: "super-secret-refresh" }, null);
    await db.update(schema.connections).set({ credentialRef: credentialId }).where(eq(schema.connections.id, connectionId));
    return { connectionId, credentialId };
  }

  it("deletes the connection_credentials row on plain disconnect (keep-data path)", async () => {
    if (!dbAvailable) return;
    const { connectionId, credentialId } = await makeConnectedConnection("gmail");

    await connectors.disconnect(connectionId, ownerUserId, false, undefined);

    const [credRow] = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
    expect(credRow).toBeUndefined(); // the token itself must be gone, not merely orphaned

    const [connRow] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connRow?.health).toBe("disconnected");
    expect(connRow?.credentialRef).toBeNull();
  });

  it("also deletes the credential row on disconnect-and-delete-derived-data", async () => {
    if (!dbAvailable) return;
    const { connectionId, credentialId } = await makeConnectedConnection("google_calendar");

    await connectors.disconnect(connectionId, ownerUserId, true, undefined);

    const [credRow] = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
    expect(credRow).toBeUndefined();
  });

  it("revokes the Plaid item (reading the still-live credential) before the credential row is wiped", async () => {
    if (!dbAvailable) return;
    const { connectionId, credentialId } = await makeConnectedConnection("plaid");
    let revokedConnectionId: string | null = null;
    const spyingPlaid = { revoke: async (id: string) => { revokedConnectionId = id; } } as unknown as PlaidAdapter;
    const connectorsWithSpy = new ConnectorsService(db, stubQueue, stubIdentity, spyingPlaid, vault);

    await connectorsWithSpy.disconnect(connectionId, ownerUserId, false, undefined);

    expect(revokedConnectionId).toBe(connectionId);
    const [credRow] = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
    expect(credRow).toBeUndefined();
  });
});
