import { describe, expect, it, vi, beforeAll, afterAll, afterEach } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { ConnectorsService } from "./connectors.service";
import { CredentialVault } from "../../common/credential-vault";

/**
 * Real, previously-missing gap: disconnect() never deleted the stored OAuth credential, so a user who
 * "disconnected" a connector still had a live, decryptable refresh token sitting in the database
 * indefinitely — and for Google-family providers, the grant was never revoked at the provider either.
 * Real DB-backed proof both halves now happen.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const vault = new CredentialVault(db);
const queueProducer = { enqueueConnectionDataDeletion: vi.fn(async () => undefined) };
const connectors = new ConnectorsService(db, queueProducer as never, vault);

const ownerUserId = generateId("user");

async function makeConnection(provider: string) {
  const connectionId = generateId("connection");
  await db.insert(schema.connections).values({
    id: connectionId,
    ownerUserId,
    provider,
    feasibilityClass: "direct_api",
    health: "healthy",
  });
  const credentialRef = await vault.store(connectionId, { access_token: "fake-access", refresh_token: "fake-refresh" }, null);
  await db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));
  return { connectionId, credentialRef };
}

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerUserId, displayName: "Disconnect Test User" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  queueProducer.enqueueConnectionDataDeletion.mockClear();
});

afterAll(async () => {
  await db.delete(schema.connections).where(eq(schema.connections.ownerUserId, ownerUserId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
});

describe("ConnectorsService.disconnect — real credential deletion + best-effort provider revoke", () => {
  it("deletes the stored credential row for a non-Google provider (no revoke call attempted)", async () => {
    const { connectionId, credentialRef } = await makeConnection("outlook");

    await connectors.disconnect(connectionId, ownerUserId, false);

    const remaining = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialRef));
    expect(remaining).toHaveLength(0);

    const [connection] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connection?.credentialRef).toBeNull();
    expect(connection?.health).toBe("disconnected");
    expect(connection?.disconnectedAt).not.toBeNull();
  });

  it("attempts a real provider-side revoke for a Google-family connection, then deletes the credential regardless of the outcome", async () => {
    const fetchSpy = vi.fn(async (_url: string | URL) => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const { connectionId, credentialRef } = await makeConnection("gmail");
    await connectors.disconnect(connectionId, ownerUserId, false);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain("oauth2.googleapis.com/revoke");

    const remaining = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialRef));
    expect(remaining).toHaveLength(0);
  });

  it("still deletes the credential even when the provider revoke call throws (best-effort, never blocks disconnect)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    );

    const { connectionId, credentialRef } = await makeConnection("google_calendar");
    await connectors.disconnect(connectionId, ownerUserId, false); // must not throw despite the revoke call failing

    const remaining = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialRef));
    expect(remaining).toHaveLength(0);
  });
});
