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
 * docs/INCIDENT_RESPONSE.md's "No provider-side token revocation call in ConnectorsService.disconnect()
 * for Google/Microsoft/Dropbox OAuth (Plaid is the one exception)" gap — this proves the fix actually sends
 * the right request to the right endpoint with the right token for Google and Dropbox, that Microsoft
 * providers (which have no callable revoke API — see connectors.service.ts's MICROSOFT_NO_REVOKE_PROVIDERS
 * doc comment) make no such call, and that a failing upstream revoke never blocks the local disconnect —
 * the local credential deletion is the real security boundary, the upstream call is defense-in-depth only.
 */
describe("ConnectorsService.disconnect — provider-side token revocation", () => {
  let db: Database;
  let vault: CredentialVault;
  let connectors: ConnectorsService;
  let ownerUserId: string;
  let dbAvailable = true;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    vault = new CredentialVault(db);
    connectors = new ConnectorsService(db, stubQueue, stubIdentity, stubPlaid, vault);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `revoke-provider-token-${ownerUserId}@example.com`, displayName: "Revoke Provider Token Test User" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping provider-side revocation tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  beforeEach(() => {
    fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function makeConnectedConnection(provider: string, accessToken: string): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider, feasibilityClass: "direct_api", scopes: [] });
    const credentialId = await vault.store(connectionId, { access_token: accessToken, refresh_token: "refresh-value" }, null);
    await db.update(schema.connections).set({ credentialRef: credentialId }).where(eq(schema.connections.id, connectionId));
    return connectionId;
  }

  it("revokes a Gmail connection's token via Google's /revoke endpoint with the stored access token", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnectedConnection("gmail", "gmail-access-token-xyz");

    await connectors.disconnect(connectionId, ownerUserId, false, undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect((init.body as URLSearchParams).get("token")).toBe("gmail-access-token-xyz");
  });

  it("revokes a Google Drive connection's token via the same Google /revoke endpoint", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnectedConnection("google_drive", "drive-access-token-123");

    await connectors.disconnect(connectionId, ownerUserId, false, undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect((init.body as URLSearchParams).get("token")).toBe("drive-access-token-123");
  });

  it("revokes a Dropbox connection's token via Dropbox's /2/auth/token/revoke endpoint with a Bearer header", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnectedConnection("dropbox", "dropbox-access-token-abc");

    await connectors.disconnect(connectionId, ownerUserId, false, undefined);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.dropboxapi.com/2/auth/token/revoke");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer dropbox-access-token-abc");
  });

  it("makes no upstream revoke call for Microsoft-family providers (no callable revoke API exists)", async () => {
    if (!dbAvailable) return;
    const connectionId = await makeConnectedConnection("outlook", "outlook-access-token");

    await connectors.disconnect(connectionId, ownerUserId, false, undefined);

    expect(fetchMock).not.toHaveBeenCalled();
    // The local credential must still be gone even with no upstream call to make.
    const [connRow] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connRow?.credentialRef).toBeNull();
  });

  it("still deletes the local credential and completes disconnect even when the upstream revoke call fails", async () => {
    if (!dbAvailable) return;
    fetchMock.mockImplementation(async () => {
      throw new Error("simulated network failure");
    });
    const connectionId = await makeConnectedConnection("gmail", "will-fail-to-revoke");

    await expect(connectors.disconnect(connectionId, ownerUserId, false, undefined)).resolves.toBeUndefined();

    const [connRow] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connRow?.health).toBe("disconnected");
    expect(connRow?.credentialRef).toBeNull();
  });
});
