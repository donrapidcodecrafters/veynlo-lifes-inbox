import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encryptField, decryptField, _resetFieldEncryptionKeyRingForTests } from "./field-encryption";

describe("field-encryption", () => {
  const ENV_KEYS = [
    "FIELD_ENCRYPTION_KEY",
    "FIELD_ENCRYPTION_KEY_VERSION",
    "FIELD_ENCRYPTION_KEY_PREVIOUS",
    "FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION",
  ] as const;
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
    process.env.FIELD_ENCRYPTION_KEY = "test-key-one-32-bytes-minimum-ok";
    delete process.env.FIELD_ENCRYPTION_KEY_VERSION;
    delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS;
    delete process.env.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION;
    _resetFieldEncryptionKeyRingForTests();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    _resetFieldEncryptionKeyRingForTests();
  });

  it("round-trips plaintext through encrypt then decrypt", () => {
    const plaintext = "Kaiser Permanente — annual physical, Dr. Nguyen";
    const ciphertext = encryptField(plaintext);
    expect(ciphertext).not.toBe(plaintext);
    expect(decryptField(ciphertext)).toBe(plaintext);
  });

  it("never stores the plaintext as a readable substring of the ciphertext", () => {
    const plaintext = "American Express •••• 1234";
    const ciphertext = encryptField(plaintext);
    expect(ciphertext).not.toContain(plaintext);
    expect(Buffer.from(ciphertext, "base64").toString("latin1")).not.toContain(plaintext);
  });

  it("produces different ciphertext for the same plaintext on repeated calls (fresh IV every time)", () => {
    const plaintext = "same value twice";
    const first = encryptField(plaintext);
    const second = encryptField(plaintext);
    expect(first).not.toBe(second);
    expect(decryptField(first)).toBe(plaintext);
    expect(decryptField(second)).toBe(plaintext);
  });

  it("round-trips unicode and empty strings correctly", () => {
    expect(decryptField(encryptField("日本語のテスト 🏥"))).toBe("日本語のテスト 🏥");
    expect(decryptField(encryptField(""))).toBe("");
  });

  it("fails closed on tampered ciphertext instead of returning corrupted plaintext", () => {
    const ciphertext = encryptField("do not tamper with me");
    const bytes = Buffer.from(ciphertext, "base64");
    const lastIndex = bytes.length - 1;
    bytes[lastIndex] = (bytes[lastIndex] ?? 0) ^ 0xff; // flip a bit in the ciphertext itself
    const tampered = bytes.toString("base64");
    expect(() => decryptField(tampered)).toThrow();
  });

  it("decrypts data written under an explicitly-versioned previous key after rotation", () => {
    // Written under version 1 (the default when FIELD_ENCRYPTION_KEY_VERSION is unset).
    const plaintext = "written before rotation";
    const ciphertextUnderOldKey = encryptField(plaintext);

    // Rotate: version 1's key becomes PREVIOUS (tagged explicitly as version 1), a new key becomes
    // version 2's current — this is the real, explicit-version rotation contract; there's no implicit
    // "whatever's current becomes previous" behavior (see the module doc comment for why).
    process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = "test-key-one-32-bytes-minimum-ok";
    process.env.FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION = "1";
    process.env.FIELD_ENCRYPTION_KEY = "test-key-two-32-bytes-minimum-ok";
    process.env.FIELD_ENCRYPTION_KEY_VERSION = "2";
    _resetFieldEncryptionKeyRingForTests();

    // Old ciphertext (version 1) still decrypts correctly against the previous key...
    expect(decryptField(ciphertextUnderOldKey)).toBe(plaintext);
    // ...and new writes use the new current key (version 2), round-tripping independently.
    const ciphertextUnderNewKey = encryptField("written after rotation");
    expect(decryptField(ciphertextUnderNewKey)).toBe("written after rotation");
  });

  it("throws a clear error when decrypting ciphertext whose version matches neither the current nor previous key", () => {
    const ciphertext = encryptField("value"); // written under the default version (1)
    // Rotate to version 2 without keeping version 1 as PREVIOUS — simulates a key lost during rotation.
    process.env.FIELD_ENCRYPTION_KEY = "a-completely-different-key-32by";
    process.env.FIELD_ENCRYPTION_KEY_VERSION = "2";
    _resetFieldEncryptionKeyRingForTests();
    expect(() => decryptField(ciphertext)).toThrow(/No field encryption key available for key version 1/);
  });

  it("requires FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION whenever FIELD_ENCRYPTION_KEY_PREVIOUS is set", () => {
    process.env.FIELD_ENCRYPTION_KEY_PREVIOUS = "some-other-key-32-bytes-minimum";
    _resetFieldEncryptionKeyRingForTests();
    expect(() => encryptField("value")).toThrow(/FIELD_ENCRYPTION_KEY_PREVIOUS_VERSION must be set/);
  });
});
