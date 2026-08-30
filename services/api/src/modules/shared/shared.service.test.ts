import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { and, eq, inArray } from "drizzle-orm";
import { SharedService } from "./shared.service";

/**
 * resolve() (the only place a public share link is actually redeemed) previously had ZERO audit logging —
 * only create/revoke were. If a link leaked, there was no record it was ever accessed. Real DB-backed
 * proof both a successful and a denied resolve now leave a real audit_events row.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const shared = new SharedService(db, {} as never);

const ownerId = generateId("user");
const itemId = generateId("attentionItem");
const shareLinkId = generateId("shareLink");
const rawToken = "test-raw-token-" + randomBytes(16).toString("hex");
const tokenHash = createHash("sha256").update(rawToken).digest("hex");

beforeAll(async () => {
  await db.insert(schema.users).values({ id: ownerId, displayName: "Owner" });
  await db.insert(schema.attentionItems).values({
    id: itemId,
    ownerUserId: ownerId,
    reasonCode: "bill_due_soon",
    reasonText: "Test bill",
    urgency: "soon",
    confidenceBand: "high",
    resolved: false,
  });
  await db.insert(schema.shareLinks).values({
    id: shareLinkId,
    resourceType: "attention_item",
    resourceId: itemId,
    tokenHash,
    createdByUserId: ownerId,
  });
});

afterAll(async () => {
  await db.delete(schema.auditEvents).where(inArray(schema.auditEvents.resourceId, [itemId, tokenHash]));
  await db.delete(schema.shareLinks).where(eq(schema.shareLinks.id, shareLinkId));
  await db.delete(schema.attentionItems).where(eq(schema.attentionItems.id, itemId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
});

describe("SharedService.resolve — access audit logging", () => {
  it("logs a successful resolve against the real resource", async () => {
    const result = await shared.resolve(rawToken);
    expect(result.resourceType).toBe("attention_item");

    const [event] = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "share_link.resolve"), eq(schema.auditEvents.resourceId, itemId)));
    expect(event).toBeDefined();
    expect(event?.actorType).toBe("anonymous");
    expect(event?.actorId).toBeNull();
    expect(event?.resourceType).toBe("attention_item");
    expect(event?.result).toBe("success");
  });

  it("logs a denied resolve against the invalid token's own hash", async () => {
    const badToken = "this-token-does-not-exist";
    const badTokenHash = createHash("sha256").update(badToken).digest("hex");

    await expect(shared.resolve(badToken)).rejects.toBeInstanceOf(NotFoundException);

    const [event] = await db
      .select()
      .from(schema.auditEvents)
      .where(and(eq(schema.auditEvents.action, "share_link.resolve"), eq(schema.auditEvents.resourceId, badTokenHash)));
    expect(event).toBeDefined();
    expect(event?.resourceType).toBe("share_link_token");
    expect(event?.result).toBe("denied");

    await db.delete(schema.auditEvents).where(eq(schema.auditEvents.resourceId, badTokenHash));
  });
});
