import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { eq, inArray } from "drizzle-orm";
import { AdminService } from "./admin.service";

/**
 * §54.2 launch criteria — real test against local Postgres proving the support-lookup redaction claim
 * in `findUserByEmail`'s own comment ("exposes only metadata... never message/document bodies or
 * financial details") actually holds, and that every lookup is audited regardless of hit/miss.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

let db: Database;
let admin: AdminService;
const userId = generateId("user");
const actingAdminId = generateId("adminUser");
const userEmail = `support-redaction-test-${userId}@example.com`;
const SENSITIVE_TITLE = "Extremely private medical bill — do not leak";

beforeAll(async () => {
  db = createDbClient(DATABASE_URL);
  admin = new AdminService(db, {} as never); // findUserByEmail never touches searchIndex
  await db.insert(schema.users).values({ id: userId, displayName: "Redaction Test User", email: userEmail });
  await db.insert(schema.documents).values({
    id: generateId("document"),
    ownerUserId: userId,
    documentType: "bill",
    title: SENSITIVE_TITLE,
    tags: [],
  });
});

afterAll(async () => {
  await db.delete(schema.documents).where(eq(schema.documents.ownerUserId, userId));
  await db.delete(schema.auditEvents).where(eq(schema.auditEvents.actorId, actingAdminId));
  await db.delete(schema.users).where(inArray(schema.users.id, [userId]));
});

describe("AdminService.findUserByEmail — support-lookup redaction", () => {
  it("never includes document content anywhere in the returned payload", async () => {
    const result = await admin.findUserByEmail(userEmail, actingAdminId);
    expect(result).not.toBeNull();
    // The redaction claim is "no content field, anywhere in the response" — asserting against the
    // serialized JSON is deliberately broader than checking a specific field, so a future field added to
    // the return shape that accidentally leaks a title/body still fails this test.
    expect(JSON.stringify(result)).not.toContain(SENSITIVE_TITLE);
  });

  it("returns only metadata keys — no field named title/body/content/summary on the top-level result", async () => {
    const result = await admin.findUserByEmail(userEmail, actingAdminId);
    const keys = Object.keys(result ?? {});
    for (const forbidden of ["title", "body", "content", "summary", "snippet"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it("audits every lookup, including a miss for an email that doesn't exist", async () => {
    const before = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorId, actingAdminId));

    await admin.findUserByEmail(userEmail, actingAdminId);
    await admin.findUserByEmail("definitely-not-a-real-user@example.com", actingAdminId);

    const after = await db.select().from(schema.auditEvents).where(eq(schema.auditEvents.actorId, actingAdminId));
    expect(after.length).toBe(before.length + 2);
    expect(after.every((e) => e.action === "admin.user_lookup")).toBe(true);
  });
});
