import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AutomationService, UNDO_WINDOW_MS } from "./automation.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * `listRuns` returned every run the account had ever produced, unbounded, while the Automations page polls
 * it every 15 seconds and renders `pastRuns.slice(0, 20)`.
 *
 * The naive fix — a plain `LIMIT` — would have been worse than the problem. The same response is what the
 * page filters for pending approvals, and an approval can sit unactioned indefinitely; truncating to the
 * newest N would hide an old one with no way for the user to ever approve it. These tests pin both halves:
 * bounded for ordinary history, complete for anything still awaiting the user.
 */
describe("AutomationService.listRuns — bounded without losing anything actionable", () => {
  let db: Database;
  let service: AutomationService;
  let userId: string;
  let ruleId: string;
  let dbAvailable = true;
  let setupError: Error | null = null;
  const OLD_PENDING_ID = generateId("automationRun");

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    // Only listRuns is exercised; its collaborators are never reached on this path.
    service = new AutomationService(db, ...([] as unknown[] as ConstructorParameters<typeof AutomationService> extends [unknown, ...infer R] ? R : never));
    try {
      userId = generateId("user");
      await db.insert(schema.users).values({ id: userId, email: `runs-${userId}@example.com`, displayName: "Runs" });
      ruleId = generateId("automationRule");
      await db.insert(schema.automationRules).values({
        id: ruleId,
        ownerUserId: userId,
        name: "Bound Test Rule",
        naturalLanguageSource: "test fixture",
        triggerDescriptor: JSON.stringify({ kind: "bill_filed" }),
        actionDescriptor: JSON.stringify({ kind: "notify" }),
        riskTier: "low",
      });

      // One approval that is OLDER than everything else, and 80 newer runs on top of it.
      const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      await db.insert(schema.automationRuns).values({
        id: OLD_PENDING_ID, ruleId, state: "approval_required", idempotencyKey: OLD_PENDING_ID, commandsJson: { kind: "notify" }, createdAt: old, updatedAt: old,
      });
      const filler = Array.from({ length: 80 }, (_, i) => {
        const id = generateId("automationRun");
        return {
        id,
        ruleId,
        idempotencyKey: id,
        commandsJson: { kind: "notify" },
        state: "succeeded" as const,
        // Well outside the undo window, so these are ordinary history and eligible for truncation.
        createdAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
        updatedAt: new Date(Date.now() - (i + 1) * 60 * 60 * 1000),
        };
      });
      await db.insert(schema.automationRuns).values(filler);
    } catch (err) {
      setupError = err as Error;
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, ruleId));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, ruleId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
  });

  // A setup failure must fail this suite, not silently pass it. Every test below short-circuits on
  // !dbAvailable, so without this the file reports green having asserted nothing — which is exactly what
  // it did on its first run: three passes against fixtures that were never inserted.
  it("actually inserted its fixtures, so the assertions below are not vacuous", () => {
    expect(setupError?.message ?? null).toBeNull();
    expect(dbAvailable).toBe(true);
  });

  it("does not return all 81 runs", async () => {
    if (!dbAvailable) return;
    const runs = await service.listRuns(userId);
    expect(runs.length).toBeLessThan(81);
  });

  it("still returns the year-old pending approval, which a plain LIMIT would have dropped", async () => {
    if (!dbAvailable) return;
    const runs = await service.listRuns(userId);
    const pending = runs.filter((r) => r.state === "approval_required");
    expect(pending.map((r) => r.id)).toContain(OLD_PENDING_ID);
  });

  it("keeps a success that is still inside its undo window", async () => {
    if (!dbAvailable) return;
    const undoableId = generateId("automationRun");
    const justNow = new Date(Date.now() - Math.floor(UNDO_WINDOW_MS / 2));
    // Backdated created_at so ordinary recency cannot be what retains it — only the undo-window rule.
    await db.insert(schema.automationRuns).values({
      id: undoableId, ruleId, state: "succeeded", idempotencyKey: undoableId, commandsJson: { kind: "notify" },
      createdAt: new Date(Date.now() - 500 * 24 * 60 * 60 * 1000), updatedAt: justNow,
    });
    const runs = await service.listRuns(userId);
    expect(runs.map((r) => r.id)).toContain(undoableId);
    await db.delete(schema.automationRuns).where(inArray(schema.automationRuns.id, [undoableId]));
  });
});
