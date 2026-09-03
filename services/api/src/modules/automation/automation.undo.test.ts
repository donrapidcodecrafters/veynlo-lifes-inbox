import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { AutomationService, UNDO_WINDOW_MS } from "./automation.service";
import { ScheduleService } from "../schedule/schedule.service";
import { ConflictService } from "../schedule/conflict.service";
import { CalendarWriteBackService } from "../connectors/calendar-write-back.service";
import { FakeModelProvider, fakeExtraction } from "../intelligence/fake-model-provider";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";
import type { HouseholdService } from "../household/household.service";
import type { AssetsService } from "../assets/assets.service";
import type { ConnectorsService } from "../connectors/connectors.service";
import type { GoogleCalendarAdapter } from "../connectors/google-calendar.adapter";
import type { MicrosoftCalendarAdapter } from "../connectors/microsoft-calendar.adapter";

/**
 * AUTO-006 "Undo / compensation" — real integration test, same shape as automation.service.test.ts.
 * Covers: undoing an `add_task` run deletes the task and marks the run `rolled_back` (spec §40.3's own
 * name for a genuine post-execution reversal — this file used to assert the old, non-spec name `undone`);
 * undoing an `add_calendar_event` run deletes the event; a run outside the 5-minute window is rejected with
 * `UNDO_WINDOW_EXPIRED` rather than silently no-op'ing; a non-owner is rejected exactly like
 * approve/reject already are; a `notify` run — which never has anything to delete — is rejected as not
 * undoable.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubNotifications = {
  createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }),
} as unknown as NotificationDeliveryService;

function buildScheduleService(db: Database): ScheduleService {
  return new ScheduleService(db, {} as HouseholdService, stubNotifications, new ConflictService(db, {} as HouseholdService), {} as AssetsService);
}
// AUTO-006/CAL-001 — undoRun's add_calendar_event branch now goes through CalendarWriteBackService.
// deleteEvent instead of a raw `db.delete`, so this needs to be a REAL instance for the undo assertions
// below (row actually gone) to still hold. None of these test events ever carry a `providerEventId`/
// `writeBackConnectionId` (they're never pushed to a provider), so `deleteEvent`'s own guard skips the
// provider call entirely and these adapter/connectors stubs are never actually invoked.
function buildCalendarWriteBack(db: Database): CalendarWriteBackService {
  return new CalendarWriteBackService(db, {} as ConnectorsService, {} as GoogleCalendarAdapter, {} as MicrosoftCalendarAdapter);
}

describe("AutomationService.undoRun", () => {
  let db: Database;
  let ownerUserId: string;
  let otherUserId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    try {
      ownerUserId = generateId("user");
      otherUserId = generateId("user");
      await db.insert(schema.users).values([
        { id: ownerUserId, email: `automation-undo-owner-${ownerUserId}@example.com`, displayName: "Undo Test Owner" },
        { id: otherUserId, email: `automation-undo-other-${otherUserId}@example.com`, displayName: "Undo Test Other" },
      ]);
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping AutomationService.undoRun tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      await db.delete(schema.users).where(eq(schema.users.id, otherUserId));
    }
  });

  async function createAndApproveRun(automation: AutomationService, ai: FakeModelProvider, action: Record<string, unknown>, triggerKind: string, category: string) {
    ai.enqueue(
      "automation_rule_parse_v1",
      fakeExtraction({
        trigger: { kind: triggerKind, merchantContains: null, minAmountMinorUnits: null, maxAmountMinorUnits: null },
        action,
        summary: `Test rule for ${String(action.kind)}`,
      }),
    );
    const rule = await automation.createRuleFromText(ownerUserId, { naturalLanguageSource: `Test rule for ${String(action.kind)}` });
    await automation.evaluateEvent({
      ownerUserId,
      householdId: null,
      category,
      linkedResourceType: category,
      linkedResourceId: generateId("bill"),
    });
    const runs = await automation.listRuns(ownerUserId);
    const run = runs.find((r) => r.ruleId === rule.id);
    if (!run) throw new Error("expected a run to have been created");
    await automation.approveRun(run.id, ownerUserId);
    return { ruleId: rule.id, runId: run.id };
  }

  async function cleanupRule(ruleId: string) {
    await db.delete(schema.automationRuns).where(eq(schema.automationRuns.ruleId, ruleId));
    await db.delete(schema.automationRules).where(eq(schema.automationRules.id, ruleId));
  }

  it("undoing a succeeded add_task run deletes the task and marks the run rolled_back", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), buildCalendarWriteBack(db));
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_task", message: null, taskTitle: "Undo me", eventTitle: null, daysFromNow: null },
      "new_purchase",
      "purchase",
    );

    const [succeededRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(succeededRun?.state).toBe("succeeded");
    expect(succeededRun?.resultResourceId).toBeTruthy();
    const taskId = succeededRun!.resultResourceId!;
    const runsBeforeUndo = await automation.listRuns(ownerUserId);
    expect(runsBeforeUndo.find((r) => r.id === runId)?.canUndo).toBe(true);

    let tasksBefore = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(tasksBefore).toHaveLength(1);

    await automation.undoRun(runId, ownerUserId);

    const [undoneRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(undoneRun?.state).toBe("rolled_back");
    const tasksAfter = await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(tasksAfter).toHaveLength(0);

    const runsAfterUndo = await automation.listRuns(ownerUserId);
    expect(runsAfterUndo.find((r) => r.id === runId)?.canUndo).toBe(false);

    // Undoing an already-undone run is rejected, not a silent no-op.
    await expect(automation.undoRun(runId, ownerUserId)).rejects.toMatchObject({ response: { code: "RUN_NOT_UNDOABLE" } });

    await cleanupRule(ruleId);
  });

  it("undoing a succeeded add_calendar_event run deletes the calendar event", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), buildCalendarWriteBack(db));
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_calendar_event", message: null, taskTitle: null, eventTitle: "Undo me too", daysFromNow: 2 },
      "new_appointment",
      "appointment",
    );

    const [succeededRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    const eventId = succeededRun!.resultResourceId!;
    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(1);

    await automation.undoRun(runId, ownerUserId);

    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(0);
    const [undoneRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(undoneRun?.state).toBe("rolled_back");

    await cleanupRule(ruleId);
  });

  /**
   * AUTO-006/CAL-001 — the real gap this closes: undoing a run whose event had ALREADY been pushed to a
   * connected provider calendar (e.g. via the generic `POST /v1/calendar-events/:id/push` endpoint) used to
   * delete only the local row, silently orphaning the event on the external Google/Microsoft calendar
   * forever (confirmed via grep before this pass — neither adapter even had a `deleteEvent` method).
   * `CalendarWriteBackService.deleteEvent` now best-effort deletes the provider-side copy first — this
   * proves undoRun actually reaches it (a fake adapter records the call) and that a provider-side failure
   * still lets the local row get deleted (log-and-continue, matching this session's established
   * "local deletion is the real boundary, provider-side is defense-in-depth" stance for connector-token
   * revocation).
   */
  it("undoing an add_calendar_event run that was pushed to a connected calendar best-effort deletes it on the provider too", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const deleteCalls: Array<{ connectionId: string; providerEventId: string }> = [];
    const fakeGoogleAdapter = {
      deleteEvent: async (connectionId: string, providerEventId: string) => {
        deleteCalls.push({ connectionId, providerEventId });
      },
    } as unknown as GoogleCalendarAdapter;
    const calendarWriteBack = new CalendarWriteBackService(
      db,
      { getOwned: async () => ({}) } as unknown as ConnectorsService,
      fakeGoogleAdapter,
      {} as MicrosoftCalendarAdapter,
    );
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), calendarWriteBack);
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_calendar_event", message: null, taskTitle: null, eventTitle: "Pushed then undone", daysFromNow: 1 },
      "new_appointment",
      "appointment",
    );
    const [succeededRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    const eventId = succeededRun!.resultResourceId!;

    // Simulate a prior successful manual push (InboxService.addToCalendar / CalendarActionsController.push).
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider: "google_calendar",
      feasibilityClass: "direct_api",
      health: "healthy",
      writeBackEnabled: true,
    });
    await db
      .update(schema.calendarEvents)
      .set({ providerEventId: "google_evt_123", writeBackConnectionId: connectionId, writeBackStatus: "pushed" })
      .where(eq(schema.calendarEvents.id, eventId));

    await automation.undoRun(runId, ownerUserId);

    expect(deleteCalls).toEqual([{ connectionId, providerEventId: "google_evt_123" }]);
    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(0);
    const [undoneRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(undoneRun?.state).toBe("rolled_back");

    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
    await cleanupRule(ruleId);
  });

  it("a provider-side delete failure during undo is logged and swallowed — the local row is still deleted", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const fakeGoogleAdapter = {
      deleteEvent: async () => {
        throw new Error("simulated Google API failure (revoked token, rate limit, etc.)");
      },
    } as unknown as GoogleCalendarAdapter;
    const calendarWriteBack = new CalendarWriteBackService(
      db,
      { getOwned: async () => ({}) } as unknown as ConnectorsService,
      fakeGoogleAdapter,
      {} as MicrosoftCalendarAdapter,
    );
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), calendarWriteBack);
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_calendar_event", message: null, taskTitle: null, eventTitle: "Pushed, provider delete fails", daysFromNow: 1 },
      "new_appointment",
      "appointment",
    );
    const [succeededRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    const eventId = succeededRun!.resultResourceId!;
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId,
      provider: "google_calendar",
      feasibilityClass: "direct_api",
      health: "healthy",
      writeBackEnabled: true,
    });
    await db
      .update(schema.calendarEvents)
      .set({ providerEventId: "google_evt_456", writeBackConnectionId: connectionId, writeBackStatus: "pushed" })
      .where(eq(schema.calendarEvents.id, eventId));

    // Must NOT throw, and must still delete the local row despite the provider call failing.
    await expect(automation.undoRun(runId, ownerUserId)).resolves.toBeUndefined();
    expect((await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, eventId)))).toHaveLength(0);

    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
    await cleanupRule(ruleId);
  });

  it("rejects undo of a notify run — nothing was created to delete, and a notification can't be un-delivered", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), buildCalendarWriteBack(db));
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "notify", message: "Heads up.", taskTitle: null, eventTitle: null, daysFromNow: null },
      "new_bill",
      "bill",
    );

    const [succeededRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(succeededRun?.state).toBe("succeeded");
    expect(succeededRun?.resultResourceId).toBeNull();

    const runs = await automation.listRuns(ownerUserId);
    expect(runs.find((r) => r.id === runId)?.canUndo).toBe(false);

    await expect(automation.undoRun(runId, ownerUserId)).rejects.toMatchObject({ response: { code: "ACTION_NOT_UNDOABLE" } });

    // Confirm it really wasn't touched.
    const [stillSucceeded] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(stillSucceeded?.state).toBe("succeeded");

    await cleanupRule(ruleId);
  });

  it("rejects undo once the 5-minute window has passed, without silently no-oping", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), buildCalendarWriteBack(db));
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_task", message: null, taskTitle: "Expired undo", eventTitle: null, daysFromNow: null },
      "new_purchase",
      "purchase",
    );

    // Backdate updatedAt past the undo window, simulating time having passed since execution.
    const staleUpdatedAt = new Date(Date.now() - UNDO_WINDOW_MS - 60_000);
    await db.update(schema.automationRuns).set({ updatedAt: staleUpdatedAt }).where(eq(schema.automationRuns.id, runId));

    const runs = await automation.listRuns(ownerUserId);
    expect(runs.find((r) => r.id === runId)?.canUndo).toBe(false);

    await expect(automation.undoRun(runId, ownerUserId)).rejects.toMatchObject({ response: { code: "UNDO_WINDOW_EXPIRED" } });

    // The task must still exist — a rejected undo must not have partially deleted anything.
    const [staleRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(staleRun?.state).toBe("succeeded");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, staleRun!.resultResourceId!)))).toHaveLength(1);

    await db.delete(schema.tasks).where(eq(schema.tasks.id, staleRun!.resultResourceId!));
    await cleanupRule(ruleId);
  });

  it("rejects undo attempted by a user who doesn't own the rule, same as approve/reject", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), buildCalendarWriteBack(db));
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_task", message: null, taskTitle: "Not yours to undo", eventTitle: null, daysFromNow: null },
      "new_purchase",
      "purchase",
    );

    await expect(automation.undoRun(runId, otherUserId)).rejects.toMatchObject({ response: { code: "RUN_NOT_FOUND" } });

    // Still succeeded, task still exists — the rejected cross-account attempt must not have touched anything.
    const [run] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(run?.state).toBe("succeeded");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, run!.resultResourceId!)))).toHaveLength(1);

    await db.delete(schema.tasks).where(eq(schema.tasks.id, run!.resultResourceId!));
    await cleanupRule(ruleId);
  });

  it("two near-simultaneous undo requests for the same run: exactly one succeeds, the other gets a clean RUN_NOT_UNDOABLE rejection", async () => {
    if (!dbAvailable) return;
    const ai = new FakeModelProvider();
    const automation = new AutomationService(db, ai, stubNotifications, buildScheduleService(db), buildCalendarWriteBack(db));
    const { ruleId, runId } = await createAndApproveRun(
      automation,
      ai,
      { kind: "add_task", message: null, taskTitle: "Race me", eventTitle: null, daysFromNow: null },
      "new_purchase",
      "purchase",
    );
    const [succeededRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    const taskId = succeededRun!.resultResourceId!;

    // Fired with Promise.allSettled (not sequential awaits) so both requests are genuinely in flight at
    // once — without the atomic `WHERE state = 'succeeded'` claim in undoRun, both would read the same
    // "succeeded" snapshot, both pass every check, and both report success.
    const results = await Promise.allSettled([automation.undoRun(runId, ownerUserId), automation.undoRun(runId, ownerUserId)]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ response: { code: "RUN_NOT_UNDOABLE" } });

    const [undoneRun] = await db.select().from(schema.automationRuns).where(eq(schema.automationRuns.id, runId));
    expect(undoneRun?.state).toBe("rolled_back");
    expect((await db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId)))).toHaveLength(0);

    await cleanupRule(ruleId);
  });
});
