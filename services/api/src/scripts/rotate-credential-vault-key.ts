/**
 * Backfill for a `CREDENTIAL_ENCRYPTION_KEY` rotation (docs/INCIDENT_RESPONSE.md §6) — the piece that
 * section flagged as a real gap when it was written ("no key-rotation mechanism... every OAuth connection
 * breaks"). CredentialVault (services/api/src/common/credential-vault.ts) now has the same versioned-key,
 * decrypt-with-old/encrypt-with-new mechanism field-encryption.ts already had; this script is the
 * operational sweep that actually moves every existing row onto the new key, mirroring the rotation
 * procedure docs/INCIDENT_RESPONSE.md §5 describes for FIELD_ENCRYPTION_KEY (which still has no equivalent
 * script of its own — see that section's "Gap" note; not fixed here, out of scope for this credential-vault
 * item specifically).
 *
 * Usage — after setting CREDENTIAL_ENCRYPTION_KEY_PREVIOUS/_PREVIOUS_VERSION (the outgoing key) and a new
 * CREDENTIAL_ENCRYPTION_KEY/_VERSION (the incoming key) and deploying:
 *
 *   pnpm --filter @veynlo/api run rotate-credential-vault-key
 *
 * Every `connection_credentials` row is read (decrypting under whichever key its embedded version byte
 * names — current or previous) and re-encrypted under the current key. Idempotent and safe to re-run: a
 * row already on the current key version is skipped (see CredentialVault.reencryptToCurrentKey), so an
 * interrupted run can simply be restarted. Only after this completes with zero failures should the
 * `_PREVIOUS` env vars be removed — until then old rows are only readable because that key is still
 * configured.
 */
import "../config/load-env-file"; // must be the first import — see its own doc comment for why
import { createDbClient } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { loadEnv } from "../config/env";
import { CredentialVault } from "../common/credential-vault";

async function main() {
  const db = createDbClient(loadEnv().DATABASE_URL);
  const vault = new CredentialVault(db);

  const rows = await db.select({ id: schema.connectionCredentials.id, encryptionKeyId: schema.connectionCredentials.encryptionKeyId }).from(schema.connectionCredentials);
  console.log(`Found ${rows.length} connection_credentials row(s).`);

  let rotated = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await vault.reencryptToCurrentKey(row.id);
      if (result.rotated) rotated++;
      else skipped++;
    } catch (err) {
      failed++;
      // Keep going — one undecryptable/corrupt row (e.g. a key genuinely lost before this ran) shouldn't
      // block re-encrypting every other row; failures are reported at the end for a human to investigate.
      console.error(`Failed to re-encrypt credential ${row.id} (was on key version ${row.encryptionKeyId}):`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`Done. Re-encrypted: ${rotated}. Already current: ${skipped}. Failed: ${failed}.`);
  if (failed > 0) {
    console.error(`${failed} row(s) failed — do NOT remove CREDENTIAL_ENCRYPTION_KEY_PREVIOUS until these are resolved.`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("rotate-credential-vault-key failed:", err);
  process.exit(1);
});
