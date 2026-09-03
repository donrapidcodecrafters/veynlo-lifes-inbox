import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../database/database.module";

/**
 * Envelope-encrypts connector OAuth credentials with AES-256-GCM before they
 * ever touch the database (§45.1 "OAuth/provider tokens live in a dedicated
 * encrypted credential subsystem... never log raw tokens"). The KMS-backed
 * key hierarchy described in the spec is a deployment concern; locally and
 * in this codebase the root key comes from CREDENTIAL_ENCRYPTION_KEY.
 *
 * Key rotation (docs/INCIDENT_RESPONSE.md §6) mirrors
 * packages/db/src/crypto/field-encryption.ts's approach exactly, once that
 * doc flagged this as "a real, current gap, not a procedure": every
 * ciphertext embeds a version byte, `CREDENTIAL_ENCRYPTION_KEY_VERSION`
 * names the current key's version, and `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`/
 * `_PREVIOUS_VERSION` keep the outgoing key available for decrypt-only so
 * rows encrypted under it stay readable during the rotation window. This
 * used to hardcode `encryptionKeyId: "v1"` on every row and have no
 * `_PREVIOUS` mechanism at all — the only "rotation" possible was treating
 * every stored token as garbage and forcing a mass reconnect (see the
 * incident-response doc's old wording, now superseded by this).
 *
 * To rotate: set `CREDENTIAL_ENCRYPTION_KEY_PREVIOUS`/`_PREVIOUS_VERSION` to
 * the outgoing key and its version, set `CREDENTIAL_ENCRYPTION_KEY`/
 * `_VERSION` to a new key and a new (higher) version number, deploy, then
 * run `pnpm --filter @veynlo/api run rotate-credential-vault-key` (see
 * `src/scripts/rotate-credential-vault-key.ts`) to re-encrypt every existing
 * row under the new key, then remove the `_PREVIOUS` vars once it completes.
 *
 * Ciphertext format (all base64): version[1] (0-255) + iv[12] + authTag[16] + ciphertext — identical
 * layout to field-encryption.ts, kept consistent deliberately even though the two never share a key.
 */
const DEFAULT_KEY_VERSION = 1;
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = 1 + 12 + AUTH_TAG_LENGTH; // version + iv + authTag, before any ciphertext bytes

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest(); // derives a stable 32-byte key regardless of input length
}

function parseVersion(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`Invalid credential-vault key version "${raw}" — must be an integer between 0 and 255.`);
  }
  return n;
}

interface KeyRing {
  current: { version: number; key: Buffer };
  previous: { version: number; key: Buffer } | null;
}

@Injectable()
export class CredentialVault {
  // Cached at instance scope (NestJS providers are singletons by default) rather than module scope like
  // field-encryption.ts's — this class already has DI-provided access to loadEnv() per-instance, so there's
  // no need for the module-level global that file uses to work around having no DI container at all.
  private keyRing: KeyRing | null = null;

  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Reads `process.env` directly rather than going through `loadEnv()` (which this class otherwise has
   * perfectly good DI access to) for the same reason field-encryption.ts's `resolveKeyRing` does, adapted
   * to a different constraint: `loadEnv()` caches its parsed result for the process's lifetime (see its own
   * doc comment — "validated once at boot"), which is exactly right for ordinary config but would make a
   * key rotation invisible to an already-running process, and — just as importantly — makes the rotation
   * path untestable within one test file (vitest gives each file its own module registry, but not a fresh
   * one per `it()`). Reading `process.env` directly, with its own instance-scoped cache
   * (`_resetKeyRingForTests` below) rather than `loadEnv`'s module-scoped one, sidesteps both problems.
   * `env.ts` still declares and production-validates `CREDENTIAL_ENCRYPTION_KEY` (see
   * `PRODUCTION_REQUIRED_SECRETS`) — this doesn't skip that check, it just doesn't ALSO route through
   * `loadEnv()`'s cache for the value itself.
   */
  private resolveKeyRing(): KeyRing {
    if (this.keyRing) return this.keyRing;

    const current = process.env.CREDENTIAL_ENCRYPTION_KEY;
    if (!current) {
      if (process.env.NODE_ENV === "production") {
        throw new Error("CREDENTIAL_ENCRYPTION_KEY is required in production — refusing to encrypt/decrypt with no key.");
      }
      // Loud, not silent — same posture as field-encryption.ts's equivalent warning.
      console.warn("[credential-vault] CREDENTIAL_ENCRYPTION_KEY not set — using an insecure dev-only default key.");
    }
    const currentVersion = parseVersion(process.env.CREDENTIAL_ENCRYPTION_KEY_VERSION, DEFAULT_KEY_VERSION);

    const previous = process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS;
    if (previous && !process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION must be set whenever CREDENTIAL_ENCRYPTION_KEY_PREVIOUS is.");
    }
    const previousVersion = previous ? parseVersion(process.env.CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION, -1) : null;
    if (previous && previousVersion === currentVersion) {
      throw new Error("CREDENTIAL_ENCRYPTION_KEY_PREVIOUS_VERSION must differ from CREDENTIAL_ENCRYPTION_KEY_VERSION.");
    }

    this.keyRing = {
      current: { version: currentVersion, key: deriveKey(current ?? "dev-only-32-byte-key-change-me!!") },
      previous: previous && previousVersion !== null ? { version: previousVersion, key: deriveKey(previous) } : null,
    };
    return this.keyRing;
  }

  /** Test-only: forces the next call to re-resolve from loadEnv() instead of reusing the cached key ring. */
  _resetKeyRingForTests(): void {
    this.keyRing = null;
  }

  private encrypt(plaintext: string): { payload: string; keyVersion: number } {
    const { current } = this.resolveKeyRing();
    const iv = randomBytes(12);
    // Explicit authTagLength (not just relying on AES-GCM's 16-byte default) closes the class of attack
    // where a shorter, forgeable tag could otherwise be accepted — flagged by this file's own SAST scan.
    const cipher = createCipheriv("aes-256-gcm", current.key, iv, { authTagLength: AUTH_TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const payload = Buffer.concat([Buffer.from([current.version]), iv, tag, ciphertext]).toString("base64");
    return { payload, keyVersion: current.version };
  }

  private decrypt(payload: string): string {
    const ring = this.resolveKeyRing();
    const buf = Buffer.from(payload, "base64");
    if (buf.length < HEADER_LENGTH) {
      // Rejects outright rather than letting a too-short buffer silently clamp `tag` below
      // AUTH_TAG_LENGTH via subarray — the same short-tag-forgery class the explicit
      // authTagLength option below guards against, just triggered by malformed input instead.
      throw new Error(`Malformed credential-vault payload: expected at least ${HEADER_LENGTH} bytes, got ${buf.length}.`);
    }
    const version = buf.readUInt8(0);
    const iv = buf.subarray(1, 13);
    const tag = buf.subarray(13, HEADER_LENGTH);
    const ciphertext = buf.subarray(HEADER_LENGTH);

    const key = version === ring.current.version ? ring.current.key : ring.previous?.version === version ? ring.previous.key : null;
    if (!key) {
      throw new Error(`No credential-vault key available for key version ${version} (set CREDENTIAL_ENCRYPTION_KEY_PREVIOUS/_VERSION if this is expected).`);
    }

    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  /** `connectionId` must already exist (create the connection row first, then store its credentials). */
  async store(connectionId: string, credentials: Record<string, unknown>, expiresAt: Date | null): Promise<string> {
    const id = generateId("credential");
    const { payload, keyVersion } = this.encrypt(JSON.stringify(credentials));
    await this.db.insert(schema.connectionCredentials).values({
      id,
      connectionId,
      encryptedPayload: payload,
      // Human-readable mirror of the version byte embedded in the ciphertext itself (the ciphertext is the
      // source of truth decrypt() actually reads) — kept for the same "readable at a glance in a DB client"
      // reason field-encryption.ts's callers never needed a parallel column for, since this one predates
      // that convention and other code may already query on it.
      encryptionKeyId: String(keyVersion),
      expiresAt,
    });
    return id;
  }

  async read(credentialRef: string): Promise<Record<string, unknown> | null> {
    const [row] = await this.db
      .select()
      .from(schema.connectionCredentials)
      .where(eq(schema.connectionCredentials.id, credentialRef))
      .limit(1);
    if (!row) return null;
    return JSON.parse(this.decrypt(row.encryptedPayload));
  }

  async rotate(credentialRef: string, credentials: Record<string, unknown>, expiresAt: Date | null): Promise<void> {
    const { payload, keyVersion } = this.encrypt(JSON.stringify(credentials));
    await this.db
      .update(schema.connectionCredentials)
      .set({ encryptedPayload: payload, encryptionKeyId: String(keyVersion), expiresAt, rotatedAt: new Date() })
      .where(eq(schema.connectionCredentials.id, credentialRef));
  }

  /**
   * Re-encrypts one row under the current key without changing its plaintext contents — the primitive
   * `rotate-credential-vault-key.ts` calls for every row during a `CREDENTIAL_ENCRYPTION_KEY` rotation.
   * Distinct from `rotate()` above: that method is for a provider handing back a genuinely new
   * token (e.g. an OAuth refresh); this one re-wraps the SAME credentials under a new key version, which is
   * exactly what a key rotation (as opposed to a token rotation) needs and nothing else in this class does.
   * A no-op read-then-write when the row is already on the current key version (idempotent — safe to re-run
   * the backfill script if it's interrupted partway through).
   */
  async reencryptToCurrentKey(credentialRef: string): Promise<{ rotated: boolean }> {
    const [row] = await this.db
      .select()
      .from(schema.connectionCredentials)
      .where(eq(schema.connectionCredentials.id, credentialRef))
      .limit(1);
    if (!row) return { rotated: false };
    const { current } = this.resolveKeyRing();
    if (row.encryptionKeyId === String(current.version)) return { rotated: false };
    const credentials = JSON.parse(this.decrypt(row.encryptedPayload));
    const { payload, keyVersion } = this.encrypt(JSON.stringify(credentials));
    await this.db
      .update(schema.connectionCredentials)
      .set({ encryptedPayload: payload, encryptionKeyId: String(keyVersion), rotatedAt: new Date() })
      .where(eq(schema.connectionCredentials.id, credentialRef));
    return { rotated: true };
  }
}
