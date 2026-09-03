import { randomBytes, createHash } from "node:crypto";

/**
 * Shared shape for "generate a random token, email a link, verify a hash of it later" flows
 * (password reset, household invite acceptance) — only the hash is ever persisted, the raw value
 * only ever exists in the emailed link and the request that redeems it.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
