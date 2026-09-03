import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AttentionService } from "./attention.service";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
  isActiveMember: async () => false,
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "stub" }) } as unknown as NotificationDeliveryService;

/**
 * `AttentionService`/`InboxService`'s "not your item" check used to throw `BadRequestException` (HTTP
 * 400) for the exact same `NOT_OWNER` code that `ScheduleService`/`DataExportService` throw as
 * `ForbiddenException` (403) for — a client written against the schedule/data-export convention would
 * mishandle the identical situation here. Proves the fix at the exception-type level (a real DB row, not
 * a mock, since `assertOwned` needs the row to exist before it can be denied).
 */
describe("AttentionService — NOT_OWNER is a 403, not a 400", () => {
  let db: Database;
  let attention: AttentionService;
  let ownerUserId: string;
  let strangerUserId: string;
  let itemId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    attention = new AttentionService(db, stubHouseholds, stubNotifications);
    try {
      ownerUserId = generateId("user");
      strangerUserId = generateId("user");
      itemId = generateId("attentionItem");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `attn-owner-${ownerUserId}@example.com`, displayName: "Owner" },
        { id: strangerUserId, email: `attn-stranger-${strangerUserId}@example.com`, displayName: "Stranger" },
      ]);
      await db.insert(schema.attentionItems).values({
        id: itemId,
        ownerUserId,
        reasonCode: "bill_due",
        reasonText: "Test bill due soon",
        urgency: "important",
        confidenceBand: "high",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AttentionService NOT_OWNER status test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.attentionItems).where(eq(schema.attentionItems.id, itemId));
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, strangerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("throws ForbiddenException (403), not BadRequestException (400), for a non-owner's resolve() call", async () => {
    if (!dbAvailable) return;
    await expect(attention.resolve(itemId, strangerUserId)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attention.resolve(itemId, strangerUserId)).rejects.toMatchObject({ response: { code: "NOT_OWNER" }, status: 403 });
  });
});
