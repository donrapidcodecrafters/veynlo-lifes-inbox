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
 * Phase 2 §52.2 "automation/rule center with safe suggest/prepare modes" — real integration test, same
 * shape as ingestion.dedup.test.ts. Covers the full lifecycle: natural-language rule parsing (via
 * FakeModelProvider, same test double the ingestion pipeline's own AI calls use), event matching
 * (merchant/amount filters), the default "prepare, don't auto-run" approval flow, idempotent
 * re-triggering, and the reject path.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const notified: { dedupeKey: string; title: string }[] = [];
const stubNotifications = {
  createAndEnqueue: async (params: { dedupeKey: string; title: string }) => {
    notified.push({ dedupeKey: params.dedupeKey, title: params.title });
    return { notificationId: "ntf_test_stub" };
  },
} as unknown as NotificationDeliveryService;

// CAL-003 "automation-created events now go through the real ScheduleService.createEvent path" — a REAL
// ConflictService (backed by the same real Postgres these tests already use) rather than a stub, so a test
// can actually assert a conflict row gets created. HouseholdService/AssetsService are never reached by
// this test file's rules (every rule here uses `householdId: null`, and mileage recurrence is irrelevant to
// automation-created events), so those stay unused stubs — same pattern as `stubNotifications` above.
function buildScheduleService(db: Database): ScheduleService {
  return new ScheduleService(
    db,
    {} as HouseholdService,
    stubNotifications,
    new ConflictService(db, {} as HouseholdService),
    {} as AssetsService,
  );
}
// undoRun is what actually calls CalendarWriteBackService.deleteEvent — none of these tests undo a run, so
// an unused stub satisfies AutomationService's constructor without needing the real ConnectorsModule graph.
const stubCalendarWriteBack = {} as CalendarWriteBackService;

describe("AutomationService", () => {
  let db: Database;
  let ownerUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `automation-test-${ownerUserId}@example.com`, displayName: "Automation Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AutomationService tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  it("parses a rule from text, matches a filtered event, prepares (not auto-runs) it, and approving executes it exactly once", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: "Comcast", minAmountMinorUnits: 15_000, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "Your Comcast bill is unusually high.", taskTitle: null, eventTitle: null, daysFromNow: null },
        summary: "Notify me when a Comcast bill arrives for more than $150.",
      }),
    );

    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Notify me if a Comcast bill is over $150" });
    expect(rule.riskTier).toBe("L0");

    const [ruleRow] = await db.select().from(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
    expect(ruleRow?.approvalMode).toBe("confirm_each_time");
    expect(ruleRow?.enabled).toBe(true);

    // Below the $150 filter — must not match.
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      amountMinorUnits: 5_000,
      merchantLabel: "Comcast Cable",
    });
    let runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(0);

    // Matches merchant + amount — must create exactly one pending run, not auto-execute it.
    const billResourceId = generateId("bill");
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: billResourceId,
      amountMinorUnits: 18_000,
      merchantLabel: "Comcast Cable",
    });
    runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("approval_required");
    const pendingRunId = runs[0]!.id;
    expect(notified.some((n) => n.dedupeKey === `automation-approval:${pendingRunId}`)).toBe(true);

    // Re-firing the same resource (e.g. a duplicate/updated bill email) must not queue a second
    // approval/execution — but §40.3 "skipped" means it must not do so *silently* either: the duplicate
    // now produces its own visible `skipped` run rather than leaving no trace it was ever re-evaluated.
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: billResourceId,
      amountMinorUnits: 18_000,
      merchantLabel: "Comcast Cable",
    });
    runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(2);
    const skippedRun = runs.find((r) => r.id !== pendingRunId);
    expect(skippedRun?.state).toBe("skipped");
    expect((skippedRun?.resultJson as { reason?: string; duplicateOfRunId?: string } | null)?.reason).toBe("duplicate_trigger");
    expect((skippedRun?.resultJson as { reason?: string; duplicateOfRunId?: string } | null)?.duplicateOfRunId).toBe(pendingRunId);
    // The original pending run itself is untouched by the duplicate — still exactly one real run to approve.
    const [stillPending] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, pendingRunId));
    expect(stillPending?.state).toBe("approval_required");

    await automation.approveRun(pendingRunId, ownerUserId);
    const [approvedRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, pendingRunId));
    expect(approvedRun?.state).toBe("succeeded");
    expect(approvedRun?.approvedByUserId).toBe(ownerUserId);
    expect(notified.some((n) => n.dedupeKey === `automation-run:${pendingRunId}` && n.title === ruleRow!.name)).toBe(true);

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });

  it("rejecting a pending run cancels it without executing the action", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_purchase", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "add_task", message: null, taskTitle: "Review this purchase", eventTitle: null, daysFromNow: null },
        summary: "Add a follow-up task whenever a new purchase is filed.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Add a task for every new purchase" });

    const purchaseResourceId = generateId("purchase");
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "purchase",
      linkedResourceType: "purchase",
      linkedResourceId: purchaseResourceId,
      amountMinorUnits: 2_500,
      merchantLabel: "Some Store",
    });
    const runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(1);

    await automation.rejectRun(runs[0]!.id, ownerUserId);
    const [rejectedRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runs[0]!.id));
    expect(rejectedRun?.state).toBe("canceled");

    const tasksCreated = await db.select().from(schema.tasks).where(eq(schema.tasks.ownerUserId, ownerUserId));
    expect(tasksCreated).toHaveLength(0);

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });

  it("approving an add_calendar_event action creates a local calendar event, never an external write", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_appointment", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "add_calendar_event", message: null, taskTitle: null, eventTitle: "Follow-up appointment", daysFromNow: 3 },
        summary: "Add a calendar event 3 days after every new appointment.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Add a calendar reminder 3 days after every appointment" });

    const appointmentResourceId = generateId("calendarEvent");
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "appointment",
      linkedResourceType: "calendarEvent",
      linkedResourceId: appointmentResourceId,
    });
    const runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(1);

    await automation.approveRun(runs[0]!.id, ownerUserId);
    const [approvedRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runs[0]!.id));
    expect(approvedRun?.state).toBe("succeeded");

    const createdEvents = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    expect(createdEvents).toHaveLength(1);
    expect(createdEvents[0]?.source).toBe("automation");
    expect(createdEvents[0]?.start).toMatchObject({ precision: "instant" });

    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.ownerUserId, ownerUserId));
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });

  /**
   * The real bug this closes: `executeRun`'s `add_calendar_event` branch used to insert directly into
   * `calendar_events`, the only calendar-event writer in this codebase that bypassed
   * `ScheduleService.createEvent` — the sole call site of `ConflictService.detectOverlaps` for a manually/
   * automation-created row. Confirmed live via an adversarial audit before this fix: an automation event
   * inserted exactly overlapping an existing one produced zero `schedule_conflicts` row. This test seeds an
   * existing event at the EXACT instant `add_calendar_event`'s own `daysFromNow`/9am arithmetic will land
   * on, then proves a real `schedule_conflicts` row naming both events now exists after the run executes.
   */
  it("an automation-created add_calendar_event run that exactly overlaps an existing event gets a real CAL-003 conflict row", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    // Mirrors executeRun's own arithmetic exactly: `daysFromNow` days from today, 9:00 AM local.
    const daysFromNow = 5;
    const conflictStart = new Date();
    conflictStart.setDate(conflictStart.getDate() + daysFromNow);
    conflictStart.setHours(9, 0, 0, 0);
    const existingEventId = generateId("calendarEvent");
    await db.insert(schema.calendarEvents).values({
      id: existingEventId,
      ownerUserId,
      title: "Pre-existing overlapping meeting",
      start: { precision: "instant", instantUtc: conflictStart.toISOString(), date: null, timezone: null, sourceText: null },
      startSort: conflictStart,
      isAllDay: false,
      source: "manual",
      status: "confirmed",
      visibility: "private",
    });

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_appointment", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "add_calendar_event", message: null, taskTitle: null, eventTitle: "Automation-created conflicting event", daysFromNow },
        summary: `Add a calendar event ${daysFromNow} days after every new appointment.`,
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Add a conflicting calendar reminder" });

    const appointmentResourceId = generateId("calendarEvent");
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "appointment",
      linkedResourceType: "calendarEvent",
      linkedResourceId: appointmentResourceId,
    });
    const runs = await automation.listRuns(ownerUserId);
    expect(runs).toHaveLength(1);
    await automation.approveRun(runs[0]!.id, ownerUserId);

    const [approvedRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runs[0]!.id));
    expect(approvedRun?.state).toBe("succeeded");
    const createdEventId = approvedRun!.resultResourceId!;
    expect(createdEventId).toBeTruthy();

    const conflicts = await db
      .select()
      .from(schema.scheduleConflicts)
      .where(eq(schema.scheduleConflicts.kind, "time_overlap"));
    const matchingConflict = conflicts.find(
      (c) => c.involvedEventIds.includes(existingEventId) && c.involvedEventIds.includes(createdEventId),
    );
    expect(matchingConflict).toBeTruthy();
    expect(matchingConflict?.resolvedAt).toBeNull();

    await db.delete(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, matchingConflict!.id));
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, existingEventId));
    await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, createdEventId));
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });

  it("AUTO-010 kill switch: a paused account creates zero new runs, even for a matching enabled rule", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "A bill arrived.", taskTitle: null, eventTitle: null, daysFromNow: null },
        summary: "Notify me for every new bill.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Notify me for every new bill" });

    expect((await automation.getKillSwitchStatus(ownerUserId)).paused).toBe(false);
    await automation.setKillSwitch(ownerUserId, true);
    expect((await automation.getKillSwitchStatus(ownerUserId)).paused).toBe(true);

    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      amountMinorUnits: 5_000,
      merchantLabel: "Some Biller",
    });
    expect(await automation.listRuns(ownerUserId)).toHaveLength(0);

    await automation.setKillSwitch(ownerUserId, false);
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      amountMinorUnits: 5_000,
      merchantLabel: "Some Biller",
    });
    expect(await automation.listRuns(ownerUserId)).toHaveLength(1);

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });

  it("AUTO-010 kill switch: also blocks approving a run that was already approval_required before the pause, and lets it through again once unpaused", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "A bill arrived.", taskTitle: null, eventTitle: null, daysFromNow: null },
        summary: "Notify me for every new bill.",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Notify me for every new bill (pause mid-flight)" });

    // Run gets created and sits approval_required while automations are still unpaused.
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: generateId("bill"),
      amountMinorUnits: 5_000,
      merchantLabel: "Some Biller",
    });
    const [pending] = await automation.listRuns(ownerUserId);
    expect(pending?.state).toBe("approval_required");

    // Kill switch flips on AFTER the run already exists — approving it must still be blocked, not just
    // suppressed for brand-new rule matches (evaluateEvent's own check, covered above).
    await automation.setKillSwitch(ownerUserId, true);
    await expect(automation.approveRun(pending!.id, ownerUserId)).rejects.toMatchObject({ response: { code: "AUTOMATIONS_PAUSED" } });

    // Rejected cleanly, not partially applied — the run is untouched, still waiting.
    const [stillPending] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, pending!.id));
    expect(stillPending?.state).toBe("approval_required");
    expect(stillPending?.approvedByUserId).toBeNull();

    // Unpausing lets the very same run be approved.
    await automation.setKillSwitch(ownerUserId, false);
    await automation.approveRun(pending!.id, ownerUserId);
    const [approved] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, pending!.id));
    expect(approved?.state).toBe("succeeded");

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });

  /**
   * Regression for a real bug found in this audit: `triggerRun`'s "one run per (rule, resource)" contract
   * was enforced only by an app-level SELECT-then-INSERT — a plain TOCTOU race. Two concurrent
   * `evaluateEvent` calls for the same (rule, resource) (realistic: several BullMQ queues here run with
   * concurrency > 1, so two separate source events about the same underlying resource — e.g. two "bill
   * updated" emails — can genuinely be processed at the same moment on different worker slots) both passed
   * the "no existing run" check before either committed its INSERT, producing two runs — and, once
   * approved/auto-run, two notifications/tasks/events for what the product promises is a single action.
   * Fixed with a real UNIQUE index (`automation_runs_idempotency_idx`) + `onConflictDoNothing`, mirroring
   * the fix already proven for `AutomationService.undoRun`'s concurrent-undo race in automation.undo.test.ts.
   * The unique index still guarantees exactly one *actionable* run — the loser of the race no longer
   * vanishes silently, though: §40.3 "skipped" means it now produces its own visible `skipped` run instead.
   */
  it("two near-simultaneous evaluateEvent calls for the same (rule, resource) create exactly one actionable run, and the loser surfaces as a visible skipped run", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), stubCalendarWriteBack);

    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: "new_bill", merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action: { kind: "notify", message: "A bill arrived.", taskTitle: null, eventTitle: null, daysFromNow: null },
        summary: "Notify me for every new bill (race test).",
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: "Notify me for every new bill (race test)" });

    const billResourceId = generateId("bill");
    const event = {
      ownerUserId,
      householdId: null,
      category: "bill",
      linkedResourceType: "bill",
      linkedResourceId: billResourceId,
      amountMinorUnits: 5_000,
      merchantLabel: "Race Co",
    };

    // Fired with Promise.allSettled (not sequential awaits) so both calls are genuinely in flight at once —
    // without the unique index + onConflictDoNothing, both pass the same "no existing run" snapshot.
    await Promise.allSettled([automation.evaluateEvent(event), automation.evaluateEvent(event)]);

    const runs = await automation.listRuns(ownerUserId);
    const actionable = runs.filter((r) => r.state !== "skipped");
    const skipped = runs.filter((r) => r.state === "skipped");
    expect(actionable).toHaveLength(1); // the unique index still allows only one real run to proceed
    expect(skipped).toHaveLength(1); // the race's loser is now visible instead of silently vanishing
    expect((skipped[0]?.resultJson as { reason?: string; duplicateOfRunId?: string } | null)?.reason).toBe("duplicate_trigger");
    expect((skipped[0]?.resultJson as { reason?: string; duplicateOfRunId?: string } | null)?.duplicateOfRunId).toBe(actionable[0]!.id);

    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, rule.id));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, rule.id));
  });
});
