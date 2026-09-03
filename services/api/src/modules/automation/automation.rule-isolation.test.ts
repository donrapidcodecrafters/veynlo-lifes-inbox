import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AutomationService } from "./automation.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { ScheduleService } from "../schedule/schedule.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
// This test only ever exercises `notify` actions — neither ScheduleService nor CalendarWriteBackService is
// ever called, so unused stubs are enough to satisfy AutomationService's constructor.
const stubSchedule = {} as ScheduleService;
const stubCalendarWriteBack = {} as CalendarWriteBackService;

/**
 * `evaluateEvent`'s per-rule loop used to have no error isolation — one matching rule's `triggerRun`
 * throwing (e.g. a transient notification-delivery failure) aborted the loop entirely, silently skipping
 * every OTHER rule that also matched the same event. This sets up two enabled rules that both match one
 * bill event; the first rule's notification delivery is made to throw, and proves the second rule still
 * gets its run created rather than being silently skipped.
 */
describe("AutomationService.evaluateEvent — one rule's failure doesn't skip the others", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `automation-isolation-${ownerUserId}@example.com`, displayName: "Automation Isolation Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AutomationService rule-isolation test — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("still creates the second rule's run when the first rule's notification delivery throws", async () => {
    if (!dbAvailable) return;
    let calls = 0;
    const flakyNotifications = {
      createAndEnqueue: async () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated notification-delivery failure");
        return { notificationId: "ntf_test_stub" };
      },
    } as unknown as NotificationDeliveryService;

    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, flakyNotifications, stubSchedule, stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "Rule A fired.", taskTitle: null, eventTitle: null, daysFromNow: null },
        summary: "Rule A: notify for every new bill.",
      }),
    );
    const ruleA = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Rule A: notify me for every new bill" });

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "Rule B fired.", taskTitle: null, eventTitle: null, daysFromNow: null },
        summary: "Rule B: notify for every new bill.",
      }),
    );
    const ruleB = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Rule B: notify me for every new bill" });

    // One event, two matching enabled rules. Rule A's created-first triggerRun's notification call is the
    // one made to throw; rule B must still get its run.
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      amountMinorUnits: 5_000,
      merchantLabel: "Some Biller",
    });

    expect(calls).toBe(2); // both rules were actually attempted, not short-circuited after the first throw
    const runs = await automation.listRuns(ownerUserId);
    const runRuleIds = runs.map((r) => r.ruleId).sort();
    expect(runRuleIds).toEqual([ruleA.id, ruleB.id].sort());

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, ruleA.id));
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, ruleB.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, ruleA.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, ruleB.id));
  });
});
