import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AutomationService } from "./automation.service";
import { ScheduleService } from "../schedule/schedule.service";
import { ConflictService } from "../schedule/conflict.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { HouseholdService } from "../household/household.service";
import type { AssetsService } from "../assets/assets.service";
import type { CalendarWriteBackService } from "../connectors/calendar-write-back.service";

/**
 * §34.1 L2 "prepare_cancellation" — real-DB proof of the "prepare mode" tier this pass adds on top of the
 * existing L0/L1 automation engine (see automation.service.test.ts for that coverage, left untouched).
 * Covers: (1) an L2 rule firing creates a distinct `prepared_actions` row, not a plain `tasks` row, seeded
 * with the real curated merchant steps; (2) the pending_confirmation -> confirmed_done / dismissed state
 * machine, including its one-way guard; (3) a merchant with no curated steps fails the run honestly rather
 * than staging an empty placeholder; (4) L0/L1 rules (notify/add_task) are entirely unaffected by any of
 * this — same behavior, same tables, as before this pass.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;

function buildScheduleService(db: Database): ScheduleService {
  return new ScheduleService(db, {} as HouseholdService, stubNotifications, new ConflictService(db, {} as HouseholdService), {} as AssetsService);
}
const stubCalendarWriteBack = {} as CalendarWriteBackService;

describe("AutomationService — §34.1 L2 prepare_cancellation", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `prepare-action-test-${ownerUserId}@example.com`, displayName: "Prepare Action Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AutomationService L2 prepare_cancellation tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("riskTierForAction classifies prepare_cancellation as L2, distinct from L0/L1", async () => {
    const { riskTierForAction } = await import("./rule-schemas");
    expect(riskTierForAction("notify")).toBe("L0");
    expect(riskTierForAction("add_task")).toBe("L1");
    expect(riskTierForAction("add_calendar_event")).toBe("L1");
    expect(riskTierForAction("prepare_cancellation")).toBe("L2");
  });

  it("an L2 rule firing for a merchant with curated steps creates a prepared_actions row (not a plain task), seeded with the real steps", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Prepare-Test Streaming Co" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId,
      ownerUserId: null,
      steps: ["Log into your account", "Go to Settings > Subscription", "Click Cancel Plan"],
      sourceNote: "Public knowledge as of this test's authoring — verify on the merchant's own site.",
    });

    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_subscription", merchantContains: "Prepare-Test Streaming Co", minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "prepare_cancellation", message: null, taskTitle: null, eventTitle: null, daysFromNow: null, prepareCancellationTitle: null },
        summary: "Prepare cancellation steps for Prepare-Test Streaming Co whenever it's detected as a subscription.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Help me cancel Prepare-Test Streaming Co if I forget" });
    expect(rule.riskTier).toBe("L2");

    const [ruleRow] = await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
    expect(ruleRow?.riskTier).toBe("L2");
    expect(ruleRow?.approvalMode).toBe("confirm_each_time");

    const subscriptionResourceId = generateId("subscription");
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "subscription",
      linkedResourceType: "subscription",
      linkedResourceId: subscriptionResourceId,
      merchantLabel: "Prepare-Test Streaming Co",
    });
    const runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("approval_required");
    expect(runs[0]?.actionKind).toBe("prepare_cancellation");

    await automation.approveRun(runs[0]!.id, ownerUserId);
    const [approvedRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runs[0]!.id));
    expect(approvedRun?.state).toBe("succeeded");
    expect(approvedRun?.triggerMerchantId).toBe(merchantId);
    expect(approvedRun?.resultResourceId).toBeTruthy();

    // L2 is never undoable via the generic run-undo path, even once succeeded — its own confirm/dismiss
    // state machine is the honest way to back out of one, not a delete-the-resource undo.
    const [succeededRun] = await automation.listRuns(ownerUserId);
    expect(succeededRun?.state).toBe("succeeded");
    expect(succeededRun?.canUndo).toBe(false);
    await expect(automation.undoRun(runs[0]!.id, ownerUserId)).rejects.toMatchObject({ response: { code: "ACTION_NOT_UNDOABLE" } });

    // The critical assertion: this created a distinct prepared_actions row, NOT a plain task.
    const tasksCreated = await db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    expect(tasksCreated).toHaveLength(0);

    const prepared = await automation.listPreparedActions(ownerUserId);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.id).toBe(approvedRun!.resultResourceId);
    expect(prepared[0]?.state).toBe("pending_confirmation");
    expect(prepared[0]?.merchantName).toBe("Prepare-Test Streaming Co");
    expect(prepared[0]?.steps).toEqual(["Log into your account", "Go to Settings > Subscription", "Click Cancel Plan"]);
    expect(prepared[0]?.sourceNote).toContain("verify on the merchant's own site");
    expect(prepared[0]?.runId).toBe(runs[0]!.id);

    await db.delete(schema.preparedActions).where(eq(schema.preparedActions.runId, runs[0]!.id));
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
    await db.delete(schema.merchantCancellationSteps).where(eq(schema.merchantCancellationSteps.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  });

  it("the prepared-action state machine: pending_confirmation -> confirmed_done is one-way, and dismiss follows the same rule", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Prepare-Test Gym Co" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId,
      ownerUserId: null,
      steps: ["Visit the front desk", "Request a cancellation form", "Submit 30 days before your renewal date"],
      sourceNote: null,
    });

    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_subscription", merchantContains: "Prepare-Test Gym Co", minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "prepare_cancellation", message: null, taskTitle: null, eventTitle: null, daysFromNow: null, prepareCancellationTitle: "Cancel the gym membership" },
        summary: "Prepare cancellation steps for Prepare-Test Gym Co.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Prepare cancellation steps for Prepare-Test Gym Co" });

    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "subscription",
      linkedResourceType: "subscription",
      linkedResourceId: generateId("subscription"),
      merchantLabel: "Prepare-Test Gym Co",
    });
    const [run] = await automation.listRuns(ownerUserId);
    await automation.approveRun(run!.id, ownerUserId);

    const [prepared] = await automation.listPreparedActions(ownerUserId);
    expect(prepared?.title).toBe("Cancel the gym membership");
    expect(prepared?.state).toBe("pending_confirmation");

    // Wrong owner can't touch it.
    const otherUserId = generateId("user");
    await db.insert(schema.users).values({ id: otherUserId, email: `prepare-action-test-other-${otherUserId}@example.com`, displayName: "Other" });
    await expect(automation.confirmPreparedAction(prepared!.id, otherUserId)).rejects.toMatchObject({ response: { code: "PREPARED_ACTION_NOT_FOUND" } });

    // Real owner confirms — one-tap "I did this myself" attestation.
    await automation.confirmPreparedAction(prepared!.id, ownerUserId);
    const [confirmed] = await db.select().from(schema.preparedActions).where(eq(schema.preparedActions.id, prepared!.id));
    expect(confirmed?.state).toBe("confirmed_done");
    expect(confirmed?.confirmedAt).toBeTruthy();
    expect(confirmed?.dismissedAt).toBeNull();

    // One-way: already confirmed, so confirming or dismissing again is rejected, not silently re-applied.
    await expect(automation.confirmPreparedAction(prepared!.id, ownerUserId)).rejects.toMatchObject({ response: { code: "PREPARED_ACTION_NOT_PENDING" } });
    await expect(automation.dismissPreparedAction(prepared!.id, ownerUserId)).rejects.toMatchObject({ response: { code: "PREPARED_ACTION_NOT_PENDING" } });

    await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    await db.delete(schema.preparedActions).where(eq(schema.preparedActions.runId, run!.id));
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
    await db.delete(schema.merchantCancellationSteps).where(eq(schema.merchantCancellationSteps.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  });

  it("dismissing a still-pending prepared action transitions it to dismissed, and a run whose merchant has no curated steps fails honestly instead of staging a placeholder", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Prepare-Test No-Steps Co" });
    // Deliberately no merchantCancellationSteps row for this merchant.

    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_subscription", merchantContains: "Prepare-Test No-Steps Co", minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "prepare_cancellation", message: null, taskTitle: null, eventTitle: null, daysFromNow: null, prepareCancellationTitle: null },
        summary: "Prepare cancellation steps for Prepare-Test No-Steps Co.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Prepare cancellation steps for Prepare-Test No-Steps Co" });

    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "subscription",
      linkedResourceType: "subscription",
      linkedResourceId: generateId("subscription"),
      merchantLabel: "Prepare-Test No-Steps Co",
    });
    const [run] = await automation.listRuns(ownerUserId);
    await automation.approveRun(run!.id, ownerUserId);

    const [failedRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, run!.id));
    expect(failedRun?.state).toBe("failed");
    expect((failedRun?.resultJson as { error?: string } | null)?.error).toContain("No cancellation steps are known");
    const preparedForNoSteps = await db.select().from(schema.preparedActions).where(eq(schema.preparedActions.runId, run!.id));
    expect(preparedForNoSteps).toHaveLength(0);

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));

    // --- Now prove dismiss on a real pending row works, using a merchant that DOES have curated steps. ---
    const merchantWithStepsId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantWithStepsId, displayName: "Prepare-Test Dismiss Co" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId: merchantWithStepsId,
      ownerUserId: null,
      steps: ["Call support", "Ask to cancel"],
      sourceNote: null,
    });
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_subscription", merchantContains: "Prepare-Test Dismiss Co", minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "prepare_cancellation", message: null, taskTitle: null, eventTitle: null, daysFromNow: null, prepareCancellationTitle: null },
        summary: "Prepare cancellation steps for Prepare-Test Dismiss Co.",
      }),
    );
    const dismissRule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Prepare cancellation steps for Prepare-Test Dismiss Co" });
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "subscription",
      linkedResourceType: "subscription",
      linkedResourceId: generateId("subscription"),
      merchantLabel: "Prepare-Test Dismiss Co",
    });
    const [dismissRunPending] = await automation.listRuns(ownerUserId);
    await automation.approveRun(dismissRunPending!.id, ownerUserId);
    const [preparedToDismiss] = await automation.listPreparedActions(ownerUserId);

    await automation.dismissPreparedAction(preparedToDismiss!.id, ownerUserId);
    const [dismissed] = await db.select().from(schema.preparedActions).where(eq(schema.preparedActions.id, preparedToDismiss!.id));
    expect(dismissed?.state).toBe("dismissed");
    expect(dismissed?.dismissedAt).toBeTruthy();
    expect(dismissed?.confirmedAt).toBeNull();

    await db.delete(schema.preparedActions).where(eq(schema.preparedActions.runId, dismissRunPending!.id));
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, dismissRule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, dismissRule.id));
    await db.delete(schema.merchantCancellationSteps).where(eq(schema.merchantCancellationSteps.merchantId, merchantWithStepsId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantWithStepsId));
  });

  it("a rule using an L2 action can never be flipped to auto_low_risk, while an L1 rule still can", async () => {
    if (!dbAvailable) return;
    const merchantId = generateId("merchant");
    await db.insert(schema.merchants).values({ id: merchantId, displayName: "Prepare-Test Guard Co" });
    await db.insert(schema.merchantCancellationSteps).values({
      id: generateId("merchantCancellationStep"),
      merchantId,
      ownerUserId: null,
      steps: ["Step one"],
      sourceNote: null,
    });

    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_subscription", merchantContains: "Prepare-Test Guard Co", minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "prepare_cancellation", message: null, taskTitle: null, eventTitle: null, daysFromNow: null, prepareCancellationTitle: null },
        summary: "Prepare cancellation steps for Prepare-Test Guard Co.",
      }),
    );
    const l2Rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Prepare cancellation steps for Prepare-Test Guard Co" });
    await expect(automation.updateRule(l2Rule.id, ownerUserId, { approvalMode: "auto_low_risk" })).rejects.toMatchObject({
      response: { code: "APPROVAL_MODE_NOT_ALLOWED" },
    });
    const [stillManual] = await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, l2Rule.id));
    expect(stillManual?.approvalMode).toBe("confirm_each_time");

    // Sanity check: an L1 rule (add_task) is unaffected by this new guard — it can still be auto-run.
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_purchase", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "add_task", message: null, taskTitle: "Review purchase", eventTitle: null, daysFromNow: null, prepareCancellationTitle: null },
        summary: "Add a follow-up task whenever a new purchase is filed.",
      }),
    );
    const l1Rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Add a task for every new purchase (guard sanity check)" });
    await automation.updateRule(l1Rule.id, ownerUserId, { approvalMode: "auto_low_risk" });
    const [l1Updated] = await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, l1Rule.id));
    expect(l1Updated?.approvalMode).toBe("auto_low_risk");

    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, l2Rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, l1Rule.id));
    await db.delete(schema.merchantCancellationSteps).where(eq(schema.merchantCancellationSteps.merchantId, merchantId));
    await db.delete(schema.merchants).where(eq(schema.merchants.id, merchantId));
  });

  it("L0/L1 rules are unaffected: notify/add_task/add_calendar_event still classify correctly, still auto-approvable, still create no prepared_actions row", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "A bill arrived.", taskTitle: null, eventTitle: null, daysFromNow: null, prepareCancellationTitle: null },
        summary: "Notify me for every new bill (L2 regression check).",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Notify me for every new bill (L2 regression check)" });
    expect(rule.riskTier).toBe("L0");
    await automation.updateRule(rule.id, ownerUserId, { approvalMode: "auto_low_risk" }); // must not throw for L0

    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      amountMinorUnits: 5_000,
      merchantLabel: "Some Biller",
    });
    const runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("succeeded"); // auto-ran, since L0 allows auto_low_risk

    const preparedActionsForOwner = await automation.listPreparedActions(ownerUserId);
    expect(preparedActionsForOwner).toHaveLength(0);

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });
});
