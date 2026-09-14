/**
 * Sorting a list by a column that is encrypted at rest.
 *
 * `encryptedText` columns hold AES-256-GCM ciphertext, and `encryptField` picks a fresh `randomBytes(12)`
 * IV on every write (see packages/db/src/crypto/field-encryption.ts). Two consequences that make SQL
 * ordering on those columns useless rather than merely imperfect:
 *
 *  - The bytes have no relationship to the text the user reads, so `ORDER BY label` is a random
 *    permutation. Measured on the seeded database: pets came back `Biscuit | Marmalade | Biscuit`, with the
 *    two Biscuits at opposite ends, and vehicles `Jordan's Civic | The Subaru | Subaru Outback`.
 *  - The same plaintext encrypts differently every time it is written, so the permutation RESHUFFLES
 *    whenever any row in the list is edited. This is a stronger version of DEF-046's tie-flapping: not a
 *    group of tied rows swapping, but the whole list rearranging after a rename.
 *
 * An `id` tiebreaker cannot fix it — the primary sort key is itself meaningless. The only correct place to
 * sort is after Drizzle has decrypted the rows, which is here.
 *
 * `localeCompare` with `sensitivity: "base"` so "the subaru" and "The Subaru" sort together, and an `id`
 * tiebreak so genuinely equal labels (two pets both called Biscuit) hold a stable order between requests.
 */
export function byDecryptedText<T>(text: (row: T) => string | null | undefined, id: (row: T) => string) {
  return (a: T, b: T): number => {
    const byText = (text(a) ?? "").localeCompare(text(b) ?? "", undefined, { sensitivity: "base" });
    if (byText !== 0) return byText;
    const [ia, ib] = [id(a), id(b)];
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  };
}
