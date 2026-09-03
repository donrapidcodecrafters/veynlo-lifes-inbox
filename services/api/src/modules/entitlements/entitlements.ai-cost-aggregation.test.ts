import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { EntitlementsService } from "./entitlements.service";
import type { Cache } from "../../cache/cache.interface";

/**
 * §47.4 "Track cost per active user" / §39.2 "Budget guardrails exist per user ... historical backfill" —
 * real Postgres coverage for `EntitlementsService.currentPeriodAiCostMinorUnits`, the single query both the
 * backfill cost-pressure pause (IngestionService.isBackfillCostBudgetPaused) and the admin cost-summary view
 * (AdminService.aiCostSummary) build on. Proves: (1) multiple runs for the SAME user in the current period
 * sum correctly, (2) a run belonging to a DIFFERENT user is never counted, and (3) a run from a PRIOR period
 * is excluded by the period-start boundary.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const noopCache: Cache = { incr: async () => 1, expire: async () => {} };

describe("EntitlementsService.currentPeriodAiCostMinorUnits — §47.4 per-user AI cost aggregation", () => {
  let db: Database;
  let entitlements: EntitlementsService;
  let targetUserId: string;
  let otherUserId: string;
  let extractorVersionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      entitlements = new EntitlementsService(db, noopCache);
      targetUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: targetUserId, email: `ai-cost-target-${targetUserId}@example.com`, displayName: "AI Cost Target" },
        { id: otherUserId, email: `ai-cost-other-${otherUserId}@example.com`, displayName: "AI Cost Other" },
      ]);
      extractorVersionId = generateId("extractorVersion");
      await db.insert(schema.extractorVersions).values({
        id: extractorVersionId,
        stage: "extraction",
        name: "ai_cost_aggregation_test_v1",
        version: "1",
        modelKey: "claude-haiku-4-5-20251001",
      });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping EntitlementsService AI-cost-aggregation tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.extractionRuns).where(eq(schema.extractionRuns.extractorVersionId, extractorVersionId));
      await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, targetUserId));
      await db.delete(schema.sourceEvents).where(eq(schema.sourceEvents.ownerUserId, otherUserId));
      await db.delete(schema.extractorVersions).where(eq(schema.extractorVersions.id, extractorVersionId));
      await db.delete(schema.users).where(eq(schema.users.id, targetUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  /** Seeds one real `source_events` + `extraction_runs` row (the same shape AnthropicExtractionService's
   * `startRun`/`finishRun` actually write) with a given cost and startedAt, so this test exercises the exact
   * join `currentPeriodAiCostMinorUnits` performs — not a synthetic shortcut. */
  async function seedRun(ownerUserId: string, costMinorUnits: number, startedAt: Date): Promise<void> {
    const sourceEventId = generateId("sourceEvent");
    await db.insert(schema.sourceEvents).values({
      id: sourceEventId,
      ownerUserId,
      kind: "email_message",
      contentHash: sourceEventId,
      occurredAt: startedAt,
      idempotencyKey: `ai-cost-test:${sourceEventId}`,
    });
    await db.insert(schema.extractionRuns).values({
      id: generateId("extractionRun"),
      sourceEventId,
      stage: "extraction",
      extractorVersionId,
      status: "success",
      costMinorUnits,
      startedAt,
      completedAt: startedAt,
    });
  }

  it("sums multiple runs for the same user in the current period, excludes another user's runs and a prior-period run", async () => {
    if (!dbAvailable) return;
    const periodStart = new Date(Date.UTC(2026, 7, 1)); // 2026-08-01 — a fixed, known boundary for this test
    const withinPeriod1 = new Date(Date.UTC(2026, 7, 5));
    const withinPeriod2 = new Date(Date.UTC(2026, 7, 20));
    const beforePeriod = new Date(Date.UTC(2026, 6, 31)); // 2026-07-31 — one day before the boundary

    // Two runs for the target user inside the period — must sum together.
    await seedRun(targetUserId, 1_200, withinPeriod1);
    await seedRun(targetUserId, 340, withinPeriod2);
    // A run for the target user, but BEFORE the period boundary — must be excluded.
    await seedRun(targetUserId, 99_999, beforePeriod);
    // A run inside the period, but for a DIFFERENT user — must never be counted toward targetUserId.
    await seedRun(otherUserId, 5_000, withinPeriod1);

    const targetTotal = await entitlements.currentPeriodAiCostMinorUnits(targetUserId, periodStart);
    expect(targetTotal).toBe(1_200 + 340);

    const otherTotal = await entitlements.currentPeriodAiCostMinorUnits(otherUserId, periodStart);
    expect(otherTotal).toBe(5_000);

    // Widening the period start to include the "before period" run proves the exclusion above was really the
    // date boundary doing its job, not some other accidental filter.
    const widerTotal = await entitlements.currentPeriodAiCostMinorUnits(targetUserId, beforePeriod);
    expect(widerTotal).toBe(1_200 + 340 + 99_999);
  });

  it("a user with zero extraction runs in the period has zero cost, not null/undefined/NaN", async () => {
    if (!dbAvailable) return;
    const neverRunUserId = generateId("user");
    const total = await entitlements.currentPeriodAiCostMinorUnits(neverRunUserId, new Date());
    expect(total).toBe(0);
  });
});
