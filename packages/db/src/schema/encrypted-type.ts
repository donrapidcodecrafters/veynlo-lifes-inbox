import { customType } from "drizzle-orm/pg-core";
import { encryptField, decryptField } from "../crypto/field-encryption";

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
      return decryptField(value);
    },
  })(name);

/**
 * Same as `encryptedText`, for columns that hold structured data
 * (arbitrary JSON) rather than a plain string — the JSON is serialized,
 * then encrypted as a whole. Because the ciphertext is opaque, Postgres's
 * `jsonb` operators (`->>`, `@>`, GIN indexes, etc.) don't work on these
 * columns anymore; only apply this to JSON columns nothing in the codebase
 * queries by path today (checked at the call sites before applying).
 */
export const encryptedJsonb = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType() {
      return "text";
    },
    toDriver(value: T): string {
      return encryptField(JSON.stringify(value));
    },
    fromDriver(value: string): T {
      return JSON.parse(decryptField(value)) as T;
    },
  })(name);
