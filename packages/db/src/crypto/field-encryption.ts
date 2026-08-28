import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Application-level field encryption for sensitive column content (§SEC-ROW:
 * "encrypted because of the type of data"). This is deliberately NOT "every
 * cell" — primary keys, foreign keys, enums used in WHERE clauses, and
 * timestamps used for sorting/range queries stay plaintext, because
 * encrypting them would break indexing, joins, and filtering outright (an
 * encrypted foreign key can't be joined; an encrypted enum can't be matched
 * in a WHERE clause; an encrypted timestamp can't be range-queried). What
 * gets encrypted here is free-text and structured *content* — names,
 * excerpts, extracted values, notification bodies, financial line-item
 * details — the kind of data that reveals what's actually going on in
 * someone's life if a database backup or a compromised read replica leaks,
 * but is never itself the target of a SQL predicate.
 *
 * AES-256-GCM, same authenticated-encryption scheme as CredentialVault
 * (services/api/src/common/credential-vault.ts), plus a real key-version
 * tag CredentialVault doesn't have yet (it hardcodes "v1").
 *
 * Key rotation is explicit and operator-driven, not inferred: every
 * ciphertext embeds the version number of whichever key encrypted it, and
 * that number comes from `FIELD_ENCRYPTION_KEY_VERSION` — set by whoever
 * configures the key, not auto-incremented by this module. An *earlier*
 * design tagged ciphertext with an implicit "current vs. previous" role
 * instead of a real version number, which silently broke on a second
 * rotation (ciphertext written under the first key got misattributed to
 * whatever key happened to occupy the "current" role by the time it was
 * read back) — caught by this file's own test suite before it shipped.
 * Explicit versions avoid that whole bug class: version numbers are
 * assigned once, by a human, and never reassigned.
 *
 * To rotate: set `FIELD_ENCRYPTION_KEY_PREVIOUS`/`FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION`
 * to the outgoing key and its version, set `FIELD_ENCRYPTION_KEY`/`FIELD_ENCRYPTION_KEY_VERSION`
 * to a new key and a new (higher) version number, deploy, then run a
 * backfill that reads and rewrites every encrypted row (which re-encrypts
 * it under the new current key on write) before removing the PREVIOUS
 * variables — otherwise anything still under the old key becomes
 * unreadable once its version falls out of both slots.
 *
 * Ciphertext format (all base64): version[1] (0-255) + iv[12] + authTag[16] + ciphertext.
 */

const DEFAULT_KEY_VERSION = 1;

function deriveKey(secret: string): Buffer {
  // Normalizes any-length input into a stable 32-byte AES-256 key — same approach as CredentialVault,
  // kept consistent so both encryption paths behave identically for any secret an operator provides.
  return createHash("sha256").update(secret).digest();
}

function parseVersion(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new Error(`Invalid field-encryption key version "${raw}" — must be an integer between 0 and 255.`);
  }
  return n;
}

interface KeyRing {
  current: { version: number; key: Buffer };
  previous: { version: number; key: Buffer } | null;
}

let keyRing: KeyRing | null = null;

/**
 * `packages/db` has no NestJS DI and customType callbacks are synchronous,
 * so this reads `process.env` directly rather than going through a
 * validated config service — services/api's env.ts still validates
 * `FIELD_ENCRYPTION_KEY` at boot (fails fast with a clear error in
 * production if it's missing/weak) using the same env var name, so
 * misconfiguration is still caught early; this is just where the actual
 * bytes get read at the point encryption/decryption happens.
 */
function resolveKeyRing(): KeyRing {
  if (keyRing) return keyRing;

  const current = process.env.FIELD_ENCRYPTION_KEY;
  if (!current) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("FIELD_ENCRYPTION_KEY is required in production — refusing to encrypt/decrypt with no key.");
    }
    // Loud, not silent: a missing key must never quietly fall back to storing plaintext.
    console.warn("[field-encryption] FIELD_ENCRYPTION_KEY not set — using an insecure dev-only default key.");
  }
  const currentVersion = parseVersion(process.env.FIELD_ENCRYPTION_KEY_VERSION, DEFAULT_KEY_VERSION);

  const previous = process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
  if (previous && !process.env.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION) {
    throw new Error("FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION must be set whenever FIELD_ENCRYPTION_KEY_PREVIOUS is.");
  }
  const previousVersion = previous ? parseVersion(process.env.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION, -1) : null;
  if (previous && previousVersion === currentVersion) {
    throw new Error("FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION must differ from FIELD_ENCRYPTION_KEY_VERSION.");
  }

  keyRing = {
    current: { version: currentVersion, key: deriveKey(current ?? "dev-only-field-encryption-key-change-me") },
    previous: previous && previousVersion !== null ? { version: previousVersion, key: deriveKey(previous) } : null,
  };
  return keyRing;
}

/** Test-only: forces the next call to re-read process.env instead of reusing the cached key ring. */
export function _resetFieldEncryptionKeyRingForTests(): void {
  keyRing = null;
}

export function encryptField(plaintext: string): string {
  const { current } = resolveKeyRing();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", current.key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from([current.version]), iv, tag, ciphertext]).toString("base64");
}

export function decryptField(stored: string): string {
  const ring = resolveKeyRing();
  const buf = Buffer.from(stored, "base64");
  const version = buf.readUInt8(0);
  const iv = buf.subarray(1, 13);
  const tag = buf.subarray(13, 29);
  const ciphertext = buf.subarray(29);

  const key = version === ring.current.version ? ring.current.key : ring.previous?.version === version ? ring.previous.key : null;
  if (!key) {
    throw new Error(`No field encryption key available for key version ${version} (set FIELD_ENCRYPTION_KEY_PREVIOUS/_VERSION if this is expected).`);
  }

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
