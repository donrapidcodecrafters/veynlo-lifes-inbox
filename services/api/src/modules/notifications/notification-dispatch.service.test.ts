import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { NotificationDispatchService } from "./notification-dispatch.service";

/**
 * Was a plain sequential for-loop over every eligible user, one createAndEnqueue await at a time — at
 * real scale this falls behind its own daily schedule, and one user's failure aborted every user after
 * them in iteration order. Proves the bounded-concurrency rewrite (services/api/src/common/concurrency.ts)
 * genuinely dispatches every real eligible user's brief, real DB reads included, even when one user's
 * delivery throws.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);

const userAId = generateId("user");
const userBId = generateId("user"); // this one's "delivery" always throws
const userCId = generateId("user");
const itemIds: [string, string, string] = [generateId("attentionItem"), generateId("attentionItem"), generateId("attentionItem")];

beforeAll(async () => {
  await db.insert(schema.users).values([
    { id: userAId, displayName: "A" },
    { id: userBId, displayName: "B" },
    { id: userCId, displayName: "C" },
  ]);
  await db.insert(schema.notificationPreferences).values([
    { userId: userAId, dailyBriefEnabled: true },
    { userId: userBId, dailyBriefEnabled: true },
    { userId: userCId, dailyBriefEnabled: true },
  ]);
  await db.insert(schema.attentionItems).values([
    { id: itemIds[0], ownerUserId: userAId, reasonCode: "bill_due_soon", reasonText: "Bill due for A", urgency: "soon", confidenceBand: "high", resolved: false },
    { id: itemIds[1], ownerUserId: userBId, reasonCode: "bill_due_soon", reasonText: "Bill due for B", urgency: "soon", confidenceBand: "high", resolved: false },
    { id: itemIds[2], ownerUserId: userCId, reasonCode: "bill_due_soon", reasonText: "Bill due for C", urgency: "soon", confidenceBand: "high", resolved: false },
  ]);
});

afterAll(async () => {
  await db.delete(schema.attentionItems).where(inArray(schema.attentionItems.id, itemIds));
  await db.delete(schema.notificationPreferences).where(inArray(schema.notificationPreferences.userId, [userAId, userBId, userCId]));
  await db.delete(schema.users).where(inArray(schema.users.id, [userAId, userBId, userCId]));
});

describe("NotificationDispatchService.dispatchDailyBrief", () => {
  it("dispatches every real eligible user even when one user's delivery throws", async () => {
    const calledFor: string[] = [];
    const delivery = {
      createAndEnqueue: vi.fn(async (params: { ownerUserId: string }) => {
        calledFor.push(params.ownerUserId);
        if (params.ownerUserId === userBId) throw new Error("simulated delivery failure for B");
        return { notificationId: generateId("notification") };
      }),
    };
    const service = new NotificationDispatchService(db, delivery as never);

    await expect(service.dispatchDailyBrief()).resolves.toBeUndefined();

    // Real DB read drove this — this dev DB has other real eligible users (seed data) too, so assert
    // our 3 are all present rather than the exact full set: all 3 (dailyBriefEnabled=true, real
    // unresolved attentionItems row each) were attempted despite B's real thrown error along the way.
    expect(calledFor).toEqual(expect.arrayContaining([userAId, userBId, userCId]));
  });
});
