import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AnalyticsService, sanitizeAnalyticsProperties, toAnalyticsPlatform } from "./analytics.service";

/**
 * §48 "Product Analytics, Experimentation & Growth" — real Postgres coverage for the first-party analytics
 * event log this pass introduces. Proves three things the task explicitly calls out:
 *   1. Emitting an event creates the expected row with the right shape (userId/householdId/platform/
 *      properties/eventName all land as given).
 *   2. No PII/raw content ever lands in `properties` — `sanitizeAnalyticsProperties` rejects the classes of
 *      input that would smuggle it in, and `AnalyticsService.track` never writes a row when that happens.
 *   3. `trackItemCaught` fires the recurring `item_caught` event every time but the one-time
 *      `first_discovery_created` milestone only on a user's very first occurrence (§48.1 Activation).
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

describe("AnalyticsService — §48 product-analytics event log", () => {
  let db: Database;
  let analytics: AnalyticsService;
  let userId: string;
  let householdId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    analytics = new AnalyticsService(db);
    try {
      userId = generateId("user");
      await db.insert(schema.users).values({ id: userId, email: `analytics-test-${userId}@example.com`, displayName: "Analytics Test User" });
      householdId = generateId("household");
      await db.insert(schema.households).values({ id: householdId, name: "Analytics Test Household", billingOwnerUserId: userId });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AnalyticsService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.productEvents).where(eq(schema.productEvents.userId, userId));
      await db.delete(schema.households).where(eq(schema.households.id, householdId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });

  it("track() writes a row with the exact shape given — eventName, userId, householdId, platform, properties", async () => {
    if (!dbAvailable) return;
    await analytics.track("capture_processed", {
      userId,
      householdId,
      platform: "mobile",
      properties: { capture_type: "voice_note" },
    });

    const [row] = await db
      .select()
      .from(schema.productEvents)
      .where(and(eq(schema.productEvents.userId, userId), eq(schema.productEvents.eventName, "capture_processed")))
      .limit(1);

    expect(row).toBeDefined();
    expect(row!.userId).toBe(userId);
    expect(row!.householdId).toBe(householdId);
    expect(row!.platform).toBe("mobile");
    expect(row!.properties).toEqual({ capture_type: "voice_note" });
    expect(row!.occurredAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("track() defaults householdId/properties to null/empty when omitted", async () => {
    if (!dbAvailable) return;
    await analytics.track("search_submitted", { userId, platform: "web" });

    const [row] = await db
      .select()
      .from(schema.productEvents)
      .where(and(eq(schema.productEvents.userId, userId), eq(schema.productEvents.eventName, "search_submitted")))
      .limit(1);

    expect(row).toBeDefined();
    expect(row!.householdId).toBeNull();
    expect(row!.properties).toEqual({});
  });

  it("track() never writes a row when properties fail sanitization (§48.2 — no PII/raw content)", async () => {
    if (!dbAvailable) return;
    // "subject" is a forbidden key substring — this is exactly the shape a careless call site could produce
    // by forwarding an email/document's subject line straight into analytics.
    await analytics.track("capture_processed", {
      userId,
      platform: "web",
      properties: { subject: "Your order has shipped" },
    });

    const rows = await db
      .select()
      .from(schema.productEvents)
      .where(and(eq(schema.productEvents.userId, userId), eq(schema.productEvents.eventName, "capture_processed")));
    // Only the earlier, legitimate capture_processed row from the first test should exist — this rejected
    // call must not have added a second one.
    expect(rows.length).toBe(1);
    expect(rows[0]!.properties).toEqual({ capture_type: "voice_note" });
  });

  it("sanitizeAnalyticsProperties rejects forbidden key substrings (email/name/body/etc.)", () => {
    expect(() => sanitizeAnalyticsProperties({ email: "someone@example.com" })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ subjectLine: "hi" })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ displayName: "Jane" })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ note: "call the plumber" })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ rawText: "..." })).toThrow();
  });

  it("sanitizeAnalyticsProperties rejects long string values and email-shaped strings under an innocuous key", () => {
    expect(() => sanitizeAnalyticsProperties({ summary: "x".repeat(101) })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ label: "someone@example.com" })).toThrow();
  });

  it("sanitizeAnalyticsProperties rejects nested objects/arrays and non-snake_case keys, but allows small structured metadata", () => {
    expect(() => sanitizeAnalyticsProperties({ nested: { a: 1 } })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ list: [1, 2, 3] })).toThrow();
    expect(() => sanitizeAnalyticsProperties({ BadKey: "x" })).toThrow();
    expect(sanitizeAnalyticsProperties({ capture_type: "voice_note", count: 3, verified: true, category: null })).toEqual({
      capture_type: "voice_note",
      count: 3,
      verified: true,
      category: null,
    });
  });

  it("toAnalyticsPlatform maps ios/android to mobile and everything else to web", () => {
    expect(toAnalyticsPlatform("ios")).toBe("mobile");
    expect(toAnalyticsPlatform("android")).toBe("mobile");
    expect(toAnalyticsPlatform("web")).toBe("web");
    expect(toAnalyticsPlatform("macos")).toBe("web");
    expect(toAnalyticsPlatform("windows")).toBe("web");
    expect(toAnalyticsPlatform("extension")).toBe("web");
  });

  it("trackItemCaught fires item_caught every time but first_discovery_created only on the first occurrence", async () => {
    if (!dbAvailable) return;
    const freshUserId = generateId("user");
    await db.insert(schema.users).values({ id: freshUserId, email: `analytics-first-discovery-${freshUserId}@example.com`, displayName: "Fresh Discovery User" });

    try {
      await analytics.trackItemCaught({ userId: freshUserId, platform: "server", properties: { category: "purchase" } });
      await analytics.trackItemCaught({ userId: freshUserId, platform: "server", properties: { category: "bill" } });

      const itemCaughtRows = await db
        .select()
        .from(schema.productEvents)
        .where(and(eq(schema.productEvents.userId, freshUserId), eq(schema.productEvents.eventName, "item_caught")));
      expect(itemCaughtRows.length).toBe(2);

      const firstDiscoveryRows = await db
        .select()
        .from(schema.productEvents)
        .where(and(eq(schema.productEvents.userId, freshUserId), eq(schema.productEvents.eventName, "first_discovery_created")));
      expect(firstDiscoveryRows.length).toBe(1);
    } finally {
      await db.delete(schema.productEvents).where(eq(schema.productEvents.userId, freshUserId));
      await db.delete(schema.users).where(eq(schema.users.id, freshUserId));
    }
  });
});
