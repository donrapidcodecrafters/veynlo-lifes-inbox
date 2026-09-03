import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { CredentialVault } from "./credential-vault";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const ENV_KEYS = ["CREDENTIAL_ENCRYPTION_KEY", "CREDENTIAL_ENCRYPTION_KEY_VERSION", "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS", "CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION"] as const;

/**
 * Regression for docs/INCIDENT_RESPONSE.md §6's "real, current gap": CredentialVault used to hardcode
 * `encryptionKeyId: "v1"` with no way to decrypt under an outgoing key while encrypting under a new one —
 * a `CREDENTIAL_ENCRYPTION_KEY` rotation meant every stored OAuth token became permanently undecryptable
 * the moment the key changed. This exercises the fix: a versioned key ring mirroring
 * packages/db/src/crypto/field-encryption.ts's mechanism, plus the `reencryptToCurrentKey` primitive
 * `rotate-credential-vault-key.ts` uses to backfill existing rows.
 */
describe("CredentialVault — key rotation", () => {
  let db: Database;
  let vault: CredentialVault;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;
  const originalEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `cred-vault-rotation-${ownerUserId}@example.com`, displayName: "Credential Vault Rotation Test User" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider: "gmail", feasibilityClass: "direct_api", scopes: [] });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping CredentialVault rotation tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.CREDENTIAL_ENCRYPTION_KEY = "rotation-test-key-one-32-bytes-!";
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION;
    vault = new CredentialVault(db);
    vault._resetKeyRingForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    vault._resetKeyRingForTests();
  });

  it("round-trips credentials through store then read", async () => {
    if (!dbAvailable) return;
    const credentialId = await vault.store(connectionId, { access_token: "tok-abc", refresh_token: "refresh-abc" }, null);
    const read = await vault.read(credentialId);
    expect(read).toEqual({ access_token: "tok-abc", refresh_token: "refresh-abc" });
    await db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
  });

  it("stamps encryptionKeyId with the current key version at write time", async () => {
    if (!dbAvailable) return;
    const credentialId = await vault.store(connectionId, { access_token: "tok-v1" }, null);
    const [row] = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
    expect(row?.encryptionKeyId).toBe("1"); // DEFAULT_KEY_VERSION when CREDENTIAL_ENCRYPTION_KEY_VERSION is unset
    await db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
  });

  it("still decrypts an old-key-encrypted credential after rotating to a new current key", async () => {
    if (!dbAvailable) return;
    // Written under version 1 (the default).
    const credentialId = await vault.store(connectionId, { access_token: "written-before-rotation" }, null);

    // Rotate: version 1's key becomes PREVIOUS, a new key becomes version 2's current.
    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = "rotation-test-key-one-32-bytes-!";
    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION = "1";
    process.env.CREDENTIAL_ENCRYPTION_KEY = "rotation-test-key-two-32-bytes-!";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "2";
    vault._resetKeyRingForTests();

    // Still readable — decrypted against the previous key, without ever being re-encrypted yet.
    const read = await vault.read(credentialId);
    expect(read).toEqual({ access_token: "written-before-rotation" });
    const [rowBeforeBackfill] = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
    expect(rowBeforeBackfill?.encryptionKeyId).toBe("1");

    await db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
  });

  it("reencryptToCurrentKey moves a row onto the new key and it stays readable once the old key is gone", async () => {
    if (!dbAvailable) return;
    const credentialId = await vault.store(connectionId, { access_token: "backfill-me" }, null);

    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS = "rotation-test-key-one-32-bytes-!";
    process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION = "1";
    process.env.CREDENTIAL_ENCRYPTION_KEY = "rotation-test-key-two-32-bytes-!";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "2";
    vault._resetKeyRingForTests();

    const result = await vault.reencryptToCurrentKey(credentialId);
    expect(result.rotated).toBe(true);

    const [rowAfterBackfill] = await db.select().from(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
    expect(rowAfterBackfill?.encryptionKeyId).toBe("2");

    // Simulate the outgoing key being fully retired (the "remove the _PREVIOUS vars" step) — this row must
    // still decrypt, since it's now genuinely encrypted under the current key, not just readable-by-luck.
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION;
    vault._resetKeyRingForTests();
    const read = await vault.read(credentialId);
    expect(read).toEqual({ access_token: "backfill-me" });

    await db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
  });

  it("reencryptToCurrentKey is a no-op (idempotent) for a row already on the current key version", async () => {
    if (!dbAvailable) return;
    const credentialId = await vault.store(connectionId, { access_token: "already-current" }, null);
    const result = await vault.reencryptToCurrentKey(credentialId); // still version 1, current is also 1
    expect(result.rotated).toBe(false);
    await db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
  });

  it("throws a clear error decrypting a key version that is neither current nor previous", async () => {
    if (!dbAvailable) return;
    const credentialId = await vault.store(connectionId, { access_token: "orphaned-key-version" }, null);

    // Rotate straight to version 3 without keeping version 1 as PREVIOUS — simulates a key lost mid-rotation.
    process.env.CREDENTIAL_ENCRYPTION_KEY = "rotation-test-key-three-32-byte";
    process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION = "3";
    vault._resetKeyRingForTests();

    await expect(vault.read(credentialId)).rejects.toThrow(/No credential-vault key available for key version 1/);

    // Cleanup needs the original key back to decrypt-and-delete cleanly; the FK cascade off the user
    // deletion in afterAll would still catch it either way, but tidy up explicitly for a clean test run.
    process.env.CREDENTIAL_ENCRYPTION_KEY = "rotation-test-key-one-32-bytes-!";
    delete process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION;
    vault._resetKeyRingForTests();
    await db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.id, credentialId));
  });
});
