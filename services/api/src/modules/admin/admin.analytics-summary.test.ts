import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AdminService } from "./admin.service";
import { IdentityService } from "../identity/identity.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { MailerService } from "../notifications/mailer.service";
import type { OnboardingService } from "../onboarding/onboarding.service";

/**
 * §48 "Product Analytics, Experimentation & Growth" — real Postgres coverage for
 * `AdminService.analyticsSummary`, the aggregation the admin dashboard's "Product analytics" section reads.
 * Proves: (1) totals/distinct-user-count are correct across multiple events for multiple users, (2) an
 * event outside the requested window is excluded by the time boundary, and (3) the by-event breakdown
 * groups by event name correctly.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubQueue = {} as unknown as QueueProducer;
const stubMailer = { send: async () => {} } as unknown as MailerService;
const stubOnboarding = { initializeForNewUser: async () => {} } as unknown as OnboardingService;

describe("AdminService.analyticsSummary — §48 admin product-analytics aggregation", () => {
  let db: Database;
  let admin: AdminService;
  let userA: string;
  let userB: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const identity = new IdentityService(db, stubQueue, stubMailer, stubOnboarding);
    admin = new AdminService(db, stubQueue, identity);
    try {
      userA = generateId("user");
      userB = generateId("user");
      await db.insert(schema.users).values([
        { id: userA, email: `analytics-summary-a-${userA}@example.com`, displayName: "Analytics Summary A" },
        { id: userB, email: `analytics-summary-b-${userB}@example.com`, displayName: "Analytics Summary B" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AdminService.analyticsSummary tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.productEvents).where(eq(schema.productEvents.userId, userA));
      await db.delete(schema.productEvents).where(eq(schema.productEvents.userId, userB));
      await db.delete(schema.users).where(eq(schema.users.id, userA));
      await db.delete(schema.users).where(eq(schema.users.id, userB));
    }
  });

  async function seedEvent(ownerUserId: string, eventName: string, occurredAt: Date): Promise<void> {
    await db.insert(schema.productEvents).values({
      id: generateId("productEvent"),
      eventName,
      userId: ownerUserId,
      platform: "web",
      properties: {},
      occurredAt,
    });
  }

  it("sums total events, counts distinct users, and excludes events outside the window", async () => {
    if (!dbAvailable) return;
    const windowDays = 7;
    const inWindow1 = new Date(Date.now() - 1 * 86_400_000);
    const inWindow2 = new Date(Date.now() - 2 * 86_400_000);
    const outsideWindow = new Date(Date.now() - 30 * 86_400_000);

    // `analyticsSummary` is deliberately a GLOBAL admin aggregate (no userId filter — that's the whole
    // point of an admin-facing total), so on a shared dev Postgres it can genuinely include real events
    // from other concurrent activity (e.g. live QA/E2E runs signing up real throwaway accounts) within
    // the same window. Captured as a baseline and asserted against by DELTA rather than an absolute count,
    // so this test stays correct regardless of what else is writing to `product_events` concurrently —
    // found live via exactly that: a concurrent QA session's real sign-ups made this test's old exact-count
    // assertions flaky (`totalEvents` was 63, not 3, though every one of userA/userB's own rows was correct).
    const baseline = await admin.analyticsSummary(windowDays);
    const baselineByEvent = new Map(baseline.byEvent.map((e) => [e.eventName, e.count]));
    const baselineTotalByDay = baseline.byDay.reduce((sum, d) => sum + d.count, 0);

    await seedEvent(userA, "signup_completed", inWindow1);
    await seedEvent(userA, "search_submitted", inWindow2);
    await seedEvent(userB, "search_submitted", inWindow1);
    await seedEvent(userA, "search_submitted", outsideWindow); // must be excluded

    const summary = await admin.analyticsSummary(windowDays);

    expect(summary.windowDays).toBe(windowDays);
    expect(summary.totalEvents - baseline.totalEvents).toBe(3); // the outside-window row must not be counted
    expect(summary.distinctUsers - baseline.distinctUsers).toBe(2); // userA and userB, not double-counted for userA's two rows

    const byEventMap = new Map(summary.byEvent.map((e) => [e.eventName, e.count]));
    expect((byEventMap.get("search_submitted") ?? 0) - (baselineByEvent.get("search_submitted") ?? 0)).toBe(2);
    expect((byEventMap.get("signup_completed") ?? 0) - (baselineByEvent.get("signup_completed") ?? 0)).toBe(1);

    const totalByDay = summary.byDay.reduce((sum, d) => sum + d.count, 0);
    expect(totalByDay - baselineTotalByDay).toBe(3);
  });
});
