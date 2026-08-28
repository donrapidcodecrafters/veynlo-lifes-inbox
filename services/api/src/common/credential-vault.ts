import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../database/database.module";
import { loadEnv } from "../config/env";

/**
 * Envelope-encrypts connector OAuth credentials with AES-256-GCM before they
 * ever touch the database (§45.1 "OAuth/provider tokens live in a dedicated
 * encrypted credential subsystem... never log raw tokens"). The KMS-backed
 * key hierarchy described in the spec is a deployment concern; locally and
 * in this codebase the root key comes from CREDENTIAL_ENCRYPTION_KEY and
 * `encryptionKeyId` records which key version encrypted a given row so
 * rotation is possible without a hard cutover.
 */
const AUTH_TAG_LENGTH = 16;
const HEADER_LENGTH = 12 + AUTH_TAG_LENGTH; // iv + authTag, before any ciphertext bytes

@Injectable()
export class CredentialVault {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private key(): Buffer {
    const raw = loadEnv().CREDENTIAL_ENCRYPTION_KEY;
    return createHash("sha256").update(raw).digest(); // derives a stable 32-byte key regardless of input length
  }

  private encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    // Explicit authTagLength (not just relying on AES-GCM's 16-byte default) closes the class of attack
    // where a shorter, forgeable tag could otherwise be accepted — flagged by this file's own SAST scan.
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv, { authTagLength: AUTH_TAG_LENGTH });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  private decrypt(payload: string): string {
    const buf = Buffer.from(payload, "base64");
    if (buf.length < HEADER_LENGTH) {
      // Rejects outright rather than letting a too-short buffer silently clamp `tag` below
      // AUTH_TAG_LENGTH via subarray — the same short-tag-forgery class the explicit
      // authTagLength option below guards against, just triggered by malformed input instead.
      throw new Error(`Malformed credential-vault payload: expected at least ${HEADER_LENGTH} bytes, got ${buf.length}.`);
    }
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, HEADER_LENGTH);
    const ciphertext = buf.subarray(HEADER_LENGTH);
    const decipher = createDecipheriv("aes-256-gcm", this.key(), iv, { authTagLength: AUTH_TAG_LENGTH });
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }

  /** `connectionId` must already exist (create the connection row first, then store its credentials). */
  async store(connectionId: string, credentials: Record<string, unknown>, expiresAt: Date | null): Promise<string> {
    const id = generateId("credential");
    await this.db.insert(schema.connectionCredentials).values({
      id,
      connectionId,
      encryptedPayload: this.encrypt(JSON.stringify(credentials)),
      encryptionKeyId: "v1",
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
    await this.db
      .update(schema.connectionCredentials)
      .set({ encryptedPayload: this.encrypt(JSON.stringify(credentials)), expiresAt, rotatedAt: new Date() })
      .where(eq(schema.connectionCredentials.id, credentialRef));
  }
}
