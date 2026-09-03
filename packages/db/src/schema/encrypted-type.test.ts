import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pgTable } from "drizzle-orm/pg-core";
import { encryptField, _resetFieldEncryptionKeyRingForTests } from "../crypto/field-encryption";
import { encryptedText, encryptedJsonb, DECRYPTION_FAILED_PLACEHOLDER } from "./encrypted-type";

describe("encrypted-type: one bad row must not fail the whole query", () => {
  beforeEach(() => {
    process.env.FIELD_ENCRYPTION_KEY = "test-key-one-32-bytes-minimum-ok";
    _resetFieldEncryptionKeyRingForTests();
  });

  afterEach(() => {
    delete process.env.FIELD_ENCRYPTION_KEY;
    _resetFieldEncryptionKeyRingForTests();
  });

  const table = pgTable("encrypted_type_test", {
    label: encryptedText("label"),
    tags: encryptedJsonb<string[]>("tags", []),
    payload: encryptedJsonb<unknown>("payload", null),
  });

  it("encryptedText returns the real value for valid ciphertext", () => {
    const ciphertext = encryptField("Dyson V15 Detect Cordless Vacuum");
    expect(table.label.mapFromDriverValue(ciphertext)).toBe("Dyson V15 Detect Cordless Vacuum");
  });

  it("encryptedText returns a placeholder (not a thrown error) for malformed ciphertext", () => {
    expect(() => table.label.mapFromDriverValue("not-valid-ciphertext")).not.toThrow();
    expect(table.label.mapFromDriverValue("not-valid-ciphertext")).toBe(DECRYPTION_FAILED_PLACEHOLDER);
  });

  it("encryptedText returns a placeholder for tampered (auth-tag-failing) ciphertext", () => {
    const ciphertext = encryptField("real value");
    const bytes = Buffer.from(ciphertext, "base64");
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff;
    const tampered = bytes.toString("base64");
    expect(table.label.mapFromDriverValue(tampered)).toBe(DECRYPTION_FAILED_PLACEHOLDER);
  });

  it("encryptedJsonb falls back to the column's declared fallback (e.g. []) instead of throwing", () => {
    expect(() => table.tags.mapFromDriverValue("garbage")).not.toThrow();
    expect(table.tags.mapFromDriverValue("garbage")).toEqual([]);
  });

  it("encryptedJsonb still round-trips real data correctly", () => {
    const ciphertext = encryptField(JSON.stringify(["warranty", "receipt"]));
    expect(table.tags.mapFromDriverValue(ciphertext)).toEqual(["warranty", "receipt"]);
  });

  it("encryptedJsonb<unknown> falls back to null on malformed ciphertext", () => {
    expect(table.payload.mapFromDriverValue("garbage")).toBeNull();
  });
});
