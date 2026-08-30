import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq } from "drizzle-orm";
import { IdentityService } from "../identity/identity.service";
import { isSenderPermitted } from "./inbound-email.controller";

/**
 * CAP-005 "permitted-senders allowlist mode" — previously named in the spec but not implemented at all:
 * any sender that passed the existing DMARC check could route mail through a forwarding alias. An empty
 * allowlist (every existing user's default) must never make this stricter than that existing check.
 */
describe("isSenderPermitted", () => {
  it("permits anyone when the allowlist is empty (the default — unchanged behavior)", () => {
    expect(isSenderPermitted("anyone@example.com", [])).toBe(true);
  });

  it("permits an exact address match", () => {
    expect(isSenderPermitted('"Jane Doe" <jane@example.com>', ["jane@example.com"])).toBe(true);
  });

  it("rejects an address not on the allowlist", () => {
    expect(isSenderPermitted("stranger@evil.example", ["jane@example.com"])).toBe(false);
  });

  it("permits any address at an allowlisted domain", () => {
    expect(isSenderPermitted("billing@company.com", ["@company.com"])).toBe(true);
    expect(isSenderPermitted("support@company.com", ["@company.com"])).toBe(true);
  });

  it("does not treat a domain entry as matching a different domain", () => {
    expect(isSenderPermitted("billing@othercompany.com", ["@company.com"])).toBe(false);
  });

  it("matches case-insensitively and unwraps a display-name-wrapped From header", () => {
    expect(isSenderPermitted('"Vendor" <Billing@Company.COM>', ["@company.com"])).toBe(true);
  });
});

describe("IdentityService — permitted inbound senders", () => {
  const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
  const db: Database = createDbClient(DATABASE_URL);
  const identity = new IdentityService(db, {} as never, {} as never);
  const userId = generateId("user");

  beforeAll(async () => {
    await db.insert(schema.users).values({ id: userId, displayName: "Allowlist Test User" });
  });

  afterAll(async () => {
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  it("defaults to an empty allowlist for a user who has never configured one", async () => {
    expect(await identity.getPermittedInboundSenders(userId)).toEqual([]);
  });

  it("persists and dedupes a real allowlist", async () => {
    const result = await identity.setPermittedInboundSenders(userId, ["jane@example.com", "@company.com", "jane@example.com"]);
    expect(result).toEqual(["jane@example.com", "@company.com"]);
    expect(await identity.getPermittedInboundSenders(userId)).toEqual(["jane@example.com", "@company.com"]);
  });

  it("clearing the allowlist (empty array) restores accept-from-anyone", async () => {
    await identity.setPermittedInboundSenders(userId, []);
    expect(await identity.getPermittedInboundSenders(userId)).toEqual([]);
  });
});
