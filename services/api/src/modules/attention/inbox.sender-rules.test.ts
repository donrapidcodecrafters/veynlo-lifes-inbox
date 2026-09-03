import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { InboxService } from "./inbox.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";
import type { ConflictService } from "../schedule/conflict.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubWriteBack = {} as unknown as CalendarWriteBackService;
const stubConflicts = {} as unknown as ConflictService;

/**
 * MAIL-006 "User sender rules" — the standalone settings-page CRUD (addSenderRule/listSenderRules/
 * removeSenderRule) and the inline "From Inbox: Always treat messages from this sender as..." action
 * (addSenderRuleFromInboxItem). Real DB integration tests, same shape as inbox.add-to-calendar.test.ts —
 * `sourceEvents.fromAddress` and `inboxItems.summary` are both encrypted columns, so this exercises the
 * ORM's real transparent encrypt/decrypt round trip, not a mocked one.
 */
describe("InboxService — MAIL-006 sender rules", () => {
  let db: Database;
  let inbox: InboxService;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    inbox = new InboxService(db, stubWriteBack, stubConflicts);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `inbox-sender-rules-${ownerUserId}@example.com`, displayName: "Inbox Sender Rules Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping InboxService MAIL-006 tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.senderRules).where(eq(schema.senderRules.ownerUserId, ownerUserId));
      await db.delete(schema.inboxItems).where(eq(schema.inboxItems.ownerUserId, ownerUserId));
      await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  it("addSenderRule creates a domain rule, listSenderRules returns it, removeSenderRule deletes it", async () => {
    if (!dbAvailable) return;
    const created = await inbox.addSenderRule(ownerUserId, { senderDomain: "acmehospital.org", action: "always_school" });
    expect(created.senderDomain).toBe("acmehospital.org");
    expect(created.action).toBe("always_school");

    const listed = await inbox.listSenderRules(ownerUserId);
    expect(listed.some((r) => r.id === created.id && r.action === "always_school")).toBe(true);

    // Add-or-update: re-submitting the same domain with a different action replaces it rather than erroring.
    const updated = await inbox.addSenderRule(ownerUserId, { senderDomain: "acmehospital.org", action: "ignore" });
    expect(updated.id).toBe(created.id);
    const listedAfterUpdate = await inbox.listSenderRules(ownerUserId);
    expect(listedAfterUpdate.filter((r) => r.senderDomain === "acmehospital.org")).toHaveLength(1);
    expect(listedAfterUpdate.find((r) => r.senderDomain === "acmehospital.org")?.action).toBe("ignore");

    await inbox.removeSenderRule(created.id, ownerUserId);
    const listedAfterRemove = await inbox.listSenderRules(ownerUserId);
    expect(listedAfterRemove.some((r) => r.id === created.id)).toBe(false);
  });

  it('addSenderRuleFromInboxItem resolves the item\'s real sourceEvents.fromAddress (an encrypted column) and creates a domain rule', async () => {
    if (!dbAvailable) return;
    const sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email_message",
      contentHash: "test-hash",
      occurredAt: new Date(),
      idempotencyKey: `test:${sourceEventId}`,
      fromAddress: "Billing Team <billing@inline-rule-test.example>",
    });
    const inboxItemId = generateId("inboxItem");
    await db.insert(schema.inboxItems).values({
      id: inboxItemId,
      ownerUserId,
      category: "bill",
      summary: "Misclassified bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      sourceEventId,
      suggestedActions: ["confirm", "correct", "dismiss"],
      confidenceBand: "needs_review",
    });

    const result = await inbox.addSenderRuleFromInboxItem(inboxItemId, ownerUserId, "always_bills");
    expect(result.senderDomain).toBe("inline-rule-test.example");
    expect(result.action).toBe("always_bills");

    const rules = await inbox.listSenderRules(ownerUserId);
    expect(rules.some((r) => r.senderDomain === "inline-rule-test.example" && r.action === "always_bills")).toBe(true);
  });
});
