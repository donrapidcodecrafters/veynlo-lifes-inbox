import { customType } from "drizzle-orm/pg-core";
import { encryptField, decryptField } from "../crypto/field-encryption";

/**
 * A single row's ciphertext can be malformed (truncated by a bad backup/restore, a botched manual edit, or
 * genuine bit rot) without the rest of the table being affected. `decryptField` throws in that case, and
 * since Drizzle calls `fromDriver` while mapping every row of a result set, one bad row used to fail the
 * *entire* query — a whole list endpoint (e.g. `GET /v1/warranties`) 500ing because one unrelated row was
 * unreadable. Logged loudly (this is a real data-integrity signal an operator should see, not something to
 * silently paper over) and isolated to just that cell instead.
 */
function logDecryptionFailure(columnName: string, err: unknown): void {
  console.error(`[field-encryption] Failed to decrypt column "${columnName}" for one row — isolating it instead of failing the whole query.`, err);
}

export const DECRYPTION_FAILED_PLACEHOLDER = "[content unavailable — decryption failed]";

/**
 * Transparently encrypted text column (§SEC-ROW — see
 * packages/db/src/crypto/field-encryption.ts for what this does and
 * doesn't cover). Application code reads/writes plain strings exactly like
 * a normal `text()` column; only the bytes actually stored in Postgres are
 * ciphertext. `null` passes through unencrypted (there's nothing to
 * protect in an absent value, and `NOT NULL` constraints still work
 * normally on the underlying column).
 *
 * Caveat this type can't hide: raw `sql\`...\`` queries (see
 * services/api's Timeline service) bypass `fromDriver`/`toDriver` entirely
 * and see the ciphertext directly — any call site that reads an encrypted
 * column via raw SQL must decrypt it manually with `decryptField` after
 * fetching.
 */
export const encryptedText = (name: string) =>
  customType<{ data: string; driverData: string }>({
    dataType() {
      return "text";
    },
    toDriver(value: string): string {
      return encryptField(value);
    },
    fromDriver(value: string): string {
      try {
        return decryptField(value);
      } catch (err) {
        logDecryptionFailure(name, err);
        return DECRYPTION_FAILED_PLACEHOLDER;
      }
    },
  })(name);

/**
 * Same as `encryptedText`, for columns that hold structured data
 * (arbitrary JSON) rather than a plain string — the JSON is serialized,
 * then encrypted as a whole. Because the ciphertext is opaque, Postgres's
 * `jsonb` operators (`->>`, `@>`, GIN indexes, etc.) don't work on these
 * columns anymore; only apply this to JSON columns nothing in the codebase
 * queries by path today (checked at the call sites before applying).
 *
 * `fallback` is required (not defaulted to e.g. `null`) because unlike text, an arbitrary `T` has no
 * universally safe stand-in — the right recovery value for a `string[]` column is `[]`, not `null`, and a
 * caller expecting a real shape for structured JSON deserves an explicit decision at the column definition,
 * not a guess made once here for every consumer.
 */
export const encryptedJsonb = <T>(name: string, fallback: T) =>
  customType<{ data: T; driverData: string }>({
    dataType() {
      return "text";
    },
    toDriver(value: T): string {
      return encryptField(JSON.stringify(value));
    },
    fromDriver(value: string): T {
      try {
        return JSON.parse(decryptField(value)) as T;
      } catch (err) {
        logDecryptionFailure(name, err);
        return fallback;
      }
    },
  })(name);
