import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId, type RecurrenceRule } from "@veynlo/core";
import { ScheduleService } from "./schedule.service";
import { ConflictService } from "./conflict.service";
import { AssetsService } from "../assets/assets.service";
import { SharingService } from "../sharing/sharing.service";
import type { RecallMonitorService } from "../assets/recall-monitor.service";
import type { VinDecodeService } from "../assets/vin-decode.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { HouseholdService } from "../household/household.service";
import type { NotificationDeliveryService } from "../notifications/notification-delivery.service";

/**
 * TASK-003 "Recurrence engine" + CAL-003 "Conflict detection" wiring — real integration test against a
 * real Postgres (same pattern as ingestion.dedup.test.ts / conflict.service.test.ts). Covers what's
 * actually new in ScheduleService: setting a recurrence rule at task/event creation, the
 * `nextOccurrences` preview surfaced on list reads, completing a recurring task rolling its due date
 * forward instead of terminating the series, and `createEvent` running CAL-003's synchronous conflict
 * check and returning the result.
 *
 * VEH-007 "mileage" rules get their own describe block below — a real AssetsService (not stubbed, unlike
 * every other dependency here) is needed to actually exercise real odometer-observation lookups, the
 * whole point of this recurrence kind existing.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const stubHouseholds = {
  isActiveMember: async () => true,
  delegatedHouseholdIds: async () => [],
  activeHouseholdIds: async () => [],
} as unknown as HouseholdService;
const stubNotifications = { createAndEnqueue: async () => ({ notificationId: "ntf_test_stub" }) } as unknown as NotificationDeliveryService;
// This describe block's own tests don't exercise mileage recurrence — stubbed no-op, same as the sharing
// test suites' identical stub.
const stubAssets = {} as unknown as AssetsService;

describe("ScheduleService recurrence + conflict wiring", () => {
  let db: Database;
  let schedule: ScheduleService;
  let ownerUserId: string;
  let dbAvailable = true;
  const createdTaskIds: string[] = [];
  const createdEventIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    schedule = new ScheduleService(db, stubHouseholds, stubNotifications, new ConflictService(db, stubHouseholds), stubAssets);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `recurrence-test-${ownerUserId}@example.com`, displayName: "Recurrence Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ScheduleService recurrence tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    const allConflicts = await db.select({ id: schema.scheduleConflicts.id, involvedEventIds: schema.scheduleConflicts.involvedEventIds }).from(schema.scheduleConflicts);
    for (const c of allConflicts.filter((c) => c.involvedEventIds.some((id) => createdEventIds.includes(id)))) {
      await db.delete(schema.scheduleConflicts).where(eq(schema.scheduleConflicts.id, c.id));
    }
    for (const id of createdTaskIds) await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
    for (const id of createdEventIds) await db.delete(schema.calendarEvents).where(eq(schema.calendarEvents.id, id));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
    expect(remaining).toHaveLength(0);
  });

  it("stores a recurrence rule set at task creation and surfaces future occurrences in tasks()", async () => {
    if (!dbAvailable) return;
    const rule: RecurrenceRule = { kind: "weekly", interval: 1, daysOfWeek: [] };
    const { id } = await schedule.createTask(ownerUserId, { title: "Take out recycling", dueIso: "2026-10-06T00:00:00.000Z", recurrenceRule: rule });
    createdTaskIds.push(id);

    const tasks = await schedule.tasks(ownerUserId);
    const created = tasks.find((t) => t.id === id);
    expect(created).toBeDefined();
    expect(created!.recurrenceRule).toEqual(rule);
    expect(created!.nextOccurrences.length).toBeGreaterThan(0);
    expect(created!.nextOccurrences[0]).toBe("2026-10-13"); // one week after the 10/6 anchor
  });

  it("rolls a recurring task's due date forward on completion instead of terminating the series", async () => {
    if (!dbAvailable) return;
    const rule: RecurrenceRule = { kind: "daily", interval: 3 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Water the plants", dueIso: "2026-10-01T00:00:00.000Z", recurrenceRule: rule });
    createdTaskIds.push(id);

    await schedule.completeTask(id, ownerUserId);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.state).toBe("open"); // not "completed" — the series continues
    expect(row!.dueCondition).toEqual({ precision: "date", instantUtc: null, date: "2026-10-04", timezone: null, sourceText: null });
  });

  it("completes a non-recurring task normally (no regression)", async () => {
    if (!dbAvailable) return;
    const { id } = await schedule.createTask(ownerUserId, { title: "One-off errand", dueIso: "2026-10-01T00:00:00.000Z" });
    createdTaskIds.push(id);

    await schedule.completeTask(id, ownerUserId);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.state).toBe("completed");
  });

  it("setTaskRecurrence lets the owner set/clear a recurrence rule after creation, and rejects non-owners", async () => {
    if (!dbAvailable) return;
    const { id } = await schedule.createTask(ownerUserId, { title: "Pay rent", dueIso: "2026-10-01T00:00:00.000Z" });
    createdTaskIds.push(id);
    const rule: RecurrenceRule = { kind: "monthly", interval: 1, dayOfMonth: 1 };

    await schedule.setTaskRecurrence(id, ownerUserId, rule);
    let [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.recurrenceRule).toEqual(rule);

    await schedule.setTaskRecurrence(id, ownerUserId, null);
    [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.recurrenceRule).toBeNull();

    const otherUserId = generateId("user");
    await expect(schedule.setTaskRecurrence(id, otherUserId, rule)).rejects.toThrow();
  });

  it("createEvent stores the recurrence rule and runs CAL-003 conflict detection synchronously", async () => {
    if (!dbAvailable) return;
    const first = await schedule.createEvent(ownerUserId, {
      title: "Recurring team sync",
      startIso: "2026-10-12T15:00:00.000Z",
      endIso: "2026-10-12T16:00:00.000Z",
      isAllDay: false,
      recurrenceRule: { kind: "weekly", interval: 1, daysOfWeek: [] },
    });
    createdEventIds.push(first.id);
    expect(first.conflicts).toHaveLength(0); // nothing else scheduled yet

    const second = await schedule.createEvent(ownerUserId, {
      title: "Overlapping dentist appointment",
      startIso: "2026-10-12T15:30:00.000Z",
      endIso: "2026-10-12T16:30:00.000Z",
      isAllDay: false,
    });
    createdEventIds.push(second.id);

    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]!.kind).toBe("time_overlap");
    expect([...second.conflicts[0]!.involvedEventIds].sort()).toEqual([first.id, second.id].sort());

    const [storedFirst] = await db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, first.id));
    expect(storedFirst!.recurrenceRule).toEqual({ kind: "weekly", interval: 1, daysOfWeek: [] });

    const events = await schedule.upcomingEvents(ownerUserId);
    const createdEvent = events.find((e) => e.id === first.id);
    expect(createdEvent!.nextOccurrences).toContain("2026-10-19");
  });
});

/**
 * VEH-007 "every 5,000 miles" mileage-based recurrence — closes the gap this same recurrence engine
 * explicitly deferred earlier (see recurrence.ts's own doc comment): there was previously no
 * odometer-tracking data source to evaluate a mileage condition against at all. Uses a REAL AssetsService
 * (unlike the describe block above, which stubs it out) specifically so `latestOdometerMileage`/
 * `earliestOdometerMileage` hit real `odometer_observations` rows — the entire point of this test is
 * proving ScheduleService actually reads the vehicle's real mileage history, not a mock of it.
 */
describe("ScheduleService mileage recurrence (VEH-007)", () => {
  let db: Database;
  let schedule: ScheduleService;
  let assets: AssetsService;
  let ownerUserId: string;
  let vehicleId: string;
  let dbAvailable = true;
  const createdTaskIds: string[] = [];
  const createdObservationIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    assets = new AssetsService(db, stubHouseholds, new SharingService(db), {} as unknown as RecallMonitorService, {} as unknown as VinDecodeService, { enqueueRecallCheck: async () => {} } as unknown as QueueProducer);
    schedule = new ScheduleService(db, stubHouseholds, stubNotifications, new ConflictService(db, stubHouseholds), assets);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `mileage-recurrence-test-${ownerUserId}@example.com`, displayName: "Mileage Recurrence Test" });
      vehicleId = generateId("vehicle");
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "Mileage Test Civic", make: "Honda", model: "Civic", year: 2020 });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ScheduleService mileage recurrence tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdTaskIds) await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
    for (const id of createdObservationIds) await db.delete(schema.odometerObservations).where(eq(schema.odometerObservations.id, id));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function addObservation(mileage: number, observedAtIso: string) {
    const { id } = await assets.recordOdometerObservation(ownerUserId, { vehicleProfileId: vehicleId, mileage, observedAtIso, source: "user_entered" });
    createdObservationIds.push(id);
  }

  it("reports not due with no odometer readings yet, and no calendar-date preview", async () => {
    if (!dbAvailable) return;
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: vehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Oil change", recurrenceRule: rule });
    createdTaskIds.push(id);

    const tasks = await schedule.tasks(ownerUserId);
    const created = tasks.find((t) => t.id === id);
    expect(created).toBeDefined();
    expect(created!.nextOccurrences).toEqual([]); // mileage rules never get a calendar-date preview
    expect(created!.mileageStatus).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: null, milesRemaining: null, isDue: false });
  });

  it("computes miles remaining and isDue against the vehicle's real latest odometer observation", async () => {
    if (!dbAvailable) return;
    await addObservation(1000, "2026-01-01");
    await addObservation(3500, "2026-03-01"); // latest — should win over the earlier, lower reading
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: vehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Tire rotation", recurrenceRule: rule });
    createdTaskIds.push(id);

    const tasks = await schedule.tasks(ownerUserId);
    const created = tasks.find((t) => t.id === id);
    expect(created!.mileageStatus).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: 3500, milesRemaining: 1500, isDue: false });

    await addObservation(5200, "2026-05-01"); // now past the 5,000-mile due point
    const tasksAfter = await schedule.tasks(ownerUserId);
    const createdAfter = tasksAfter.find((t) => t.id === id);
    expect(createdAfter!.mileageStatus).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: 5200, milesRemaining: 0, isDue: true });
  });

  it("falls back to the vehicle's earliest known odometer reading as the baseline when none is set on the rule", async () => {
    if (!dbAvailable) return;
    // Reuses the same vehicle's observation history seeded above (earliest = 1000 mi @ 2026-01-01, latest = 5200 mi).
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 3000, vehicleProfileId: vehicleId, baselineMileage: null };
    const { id } = await schedule.createTask(ownerUserId, { title: "Brake inspection", recurrenceRule: rule });
    createdTaskIds.push(id);

    const tasks = await schedule.tasks(ownerUserId);
    const created = tasks.find((t) => t.id === id);
    expect(created!.mileageStatus!.baselineMileage).toBe(1000); // the earliest reading, not 0
    expect(created!.mileageStatus!.dueAtMileage).toBe(4000);
    expect(created!.mileageStatus!.isDue).toBe(true); // 5200 >= 4000
  });

  it("re-anchors the baseline to the vehicle's current mileage on completion, rather than computing a calendar date", async () => {
    if (!dbAvailable) return;
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: vehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Cabin air filter", recurrenceRule: rule });
    createdTaskIds.push(id);

    await schedule.completeTask(id, ownerUserId); // latest odometer reading at this point is 5200 (seeded above)

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.state).toBe("open"); // not "completed" — the series continues, same as a date-based recurring task
    expect(row!.dueCondition).toBeNull(); // mileage rules never populate a calendar due date
    expect(row!.recurrenceRule).toEqual({ kind: "mileage", intervalMiles: 5000, vehicleProfileId: vehicleId, baselineMileage: 5200 });
  });

  it("falls back to ordinary one-time completion when the vehicle has no odometer reading at all", async () => {
    if (!dbAvailable) return;
    const freshVehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: freshVehicleId, ownerUserId, label: "No-mileage-yet car", make: "Toyota", model: "Corolla", year: 2022 });
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: freshVehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "First service", recurrenceRule: rule });
    createdTaskIds.push(id);

    await schedule.completeTask(id, ownerUserId);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.state).toBe("completed"); // no reading to re-anchor to — behaves like a one-off task
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, freshVehicleId));
  });

  /**
   * VEH-001 "odometer rollback/data error" edge state — a bad/stray odometer entry (typo, wrong vehicle,
   * stale receipt mileage) recorded with a LATER timestamp than the vehicle's true current mileage must
   * not silently become the "current" reading used for mileage-due evaluation: doing so could flip an
   * already-DUE maintenance task back to not-due with nothing surfaced to the user. Found live against the
   * running dev API during this audit (a real oil-change task went from isDue:true at 5,200mi back to
   * isDue:false after a later-dated 200mi entry), then reproduced here against real Postgres.
   */
  it("does not let a later-dated but LOWER odometer reading roll a due maintenance task back to not-due", async () => {
    if (!dbAvailable) return;
    const rollbackVehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: rollbackVehicleId, ownerUserId, label: "Rollback Test Wagon", make: "Subaru", model: "Outback", year: 2019 });
    const rule: RecurrenceRule = { kind: "mileage", intervalMiles: 5000, vehicleProfileId: rollbackVehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Rollback oil change", recurrenceRule: rule });
    createdTaskIds.push(id);

    // addObservation() (used elsewhere in this describe block) hardcodes the shared `vehicleId` fixture —
    // this test needs its own isolated vehicle, so it calls AssetsService directly instead.
    async function addRollbackVehicleObservation(mileage: number, observedAtIso: string) {
      const { id: obsId } = await assets.recordOdometerObservation(ownerUserId, { vehicleProfileId: rollbackVehicleId, mileage, observedAtIso, source: "user_entered" });
      createdObservationIds.push(obsId);
    }

    await addRollbackVehicleObservation(5001, "2026-04-01"); // pushes the task past its 5,000mi due point
    let tasks = await schedule.tasks(ownerUserId);
    expect(tasks.find((t) => t.id === id)!.mileageStatus).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: 5001, milesRemaining: 0, isDue: true });

    // A stray, much lower reading recorded AFTER the true current mileage — a data-entry error, not a
    // legitimate new "latest" reading.
    await addRollbackVehicleObservation(200, "2026-05-01");
    tasks = await schedule.tasks(ownerUserId);
    expect(tasks.find((t) => t.id === id)!.mileageStatus).toEqual({ baselineMileage: 0, dueAtMileage: 5000, currentMileage: 5001, milesRemaining: 0, isDue: true }); // still due — the rollback entry is inert for status purposes

    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, rollbackVehicleId));
  });
});

/**
 * VEH-003 "mileage/time rules coexist, whichever comes first" composite rule — the "3 months OR 3,000
 * miles" idiom, built on top of the same real AssetsService/odometer-observation wiring the VEH-007 block
 * above proves works for the mileage-only case. Focuses on what's genuinely new here: `tasks()` surfacing
 * a combined status with BOTH a calendar due date and a mileage status, `isDue` going true from either
 * side independently, and `completeTask` re-anchoring both the stored due date AND baselineMileage
 * together on completion.
 */
describe("ScheduleService mileage_or_calendar recurrence (VEH-003)", () => {
  let db: Database;
  let schedule: ScheduleService;
  let assets: AssetsService;
  let ownerUserId: string;
  let vehicleId: string;
  let dbAvailable = true;
  const createdTaskIds: string[] = [];
  const createdObservationIds: string[] = [];

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    assets = new AssetsService(db, stubHouseholds, new SharingService(db), {} as unknown as RecallMonitorService, {} as unknown as VinDecodeService, { enqueueRecallCheck: async () => {} } as unknown as QueueProducer);
    schedule = new ScheduleService(db, stubHouseholds, stubNotifications, new ConflictService(db, stubHouseholds), assets);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `mileage-or-calendar-test-${ownerUserId}@example.com`, displayName: "Mileage Or Calendar Test" });
      vehicleId = generateId("vehicle");
      await db.insert(schema.vehicleProfiles).values({ id: vehicleId, ownerUserId, label: "Mileage-Or-Calendar Test CR-V", make: "Honda", model: "CR-V", year: 2021 });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping ScheduleService mileage_or_calendar recurrence tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    for (const id of createdTaskIds) await db.delete(schema.tasks).where(eq(schema.tasks.id, id));
    for (const id of createdObservationIds) await db.delete(schema.odometerObservations).where(eq(schema.odometerObservations.id, id));
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, vehicleId));
    await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
  });

  async function addObservation(mileage: number, observedAtIso: string) {
    const { id } = await assets.recordOdometerObservation(ownerUserId, { vehicleProfileId: vehicleId, mileage, observedAtIso, source: "user_entered" });
    createdObservationIds.push(id);
  }

  it("surfaces a combined mileageOrCalendarStatus (no calendar-date preview) and is due once the calendar side alone passes", async () => {
    if (!dbAvailable) return;
    const rule: RecurrenceRule = { kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 3000, vehicleProfileId: vehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Oil change (time or mileage)", dueIso: "2026-01-01T00:00:00.000Z", recurrenceRule: rule });
    createdTaskIds.push(id);

    const tasks = await schedule.tasks(ownerUserId);
    const created = tasks.find((t) => t.id === id);
    expect(created).toBeDefined();
    expect(created!.nextOccurrences).toEqual([]); // composite rules never get a calendar-date *series* preview, same as pure mileage
    expect(created!.mileageStatus).toBeNull();
    expect(created!.mileageOrCalendarStatus!.calendarDueDate).toBe("2026-04-01"); // 3 months after the 1/1 anchor
    expect(created!.mileageOrCalendarStatus!.mileage.isDue).toBe(false); // no odometer readings yet
    // Real system clock is well past 2026-04-01 as of this test running, so the calendar side alone makes it due.
    expect(created!.mileageOrCalendarStatus!.isDue).toBe(true);
  });

  it("is due once the mileage side alone reaches its threshold, even with the calendar date far in the future", async () => {
    if (!dbAvailable) return;
    await addObservation(2000, "2026-01-01");
    await addObservation(3400, "2026-02-01"); // past the 3,000-mile threshold
    const rule: RecurrenceRule = { kind: "mileage_or_calendar", intervalMonths: 12, intervalMiles: 3000, vehicleProfileId: vehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Tire rotation (time or mileage)", dueIso: "2026-01-01T00:00:00.000Z", recurrenceRule: rule });
    createdTaskIds.push(id);

    const tasks = await schedule.tasks(ownerUserId);
    const created = tasks.find((t) => t.id === id);
    expect(created!.mileageOrCalendarStatus!.calendarDueDate).toBe("2027-01-01"); // far off — the 12-month side isn't why this is due
    expect(created!.mileageOrCalendarStatus!.mileage).toEqual({ baselineMileage: 0, dueAtMileage: 3000, currentMileage: 3400, milesRemaining: 0, isDue: true });
    expect(created!.mileageOrCalendarStatus!.isDue).toBe(true);
  });

  it("completeTask re-anchors BOTH the stored due date AND baselineMileage together", async () => {
    if (!dbAvailable) return;
    const rule: RecurrenceRule = { kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 5000, vehicleProfileId: vehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "Cabin filter (time or mileage)", dueIso: "2026-06-15T00:00:00.000Z", recurrenceRule: rule });
    createdTaskIds.push(id);

    await schedule.completeTask(id, ownerUserId); // latest odometer reading at this point is 3400 (seeded above)

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.state).toBe("open"); // the series continues, same as every other recurring-completion path
    expect(row!.dueCondition).toEqual({ precision: "date", instantUtc: null, date: "2026-09-15", timezone: null, sourceText: null }); // 3 months past the 6/15 due date it had
    expect(row!.recurrenceRule).toEqual({ kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 5000, vehicleProfileId: vehicleId, baselineMileage: 3400 }); // re-anchored to the current reading
  });

  it("falls back to ordinary one-time completion when the vehicle has no odometer reading at all", async () => {
    if (!dbAvailable) return;
    const freshVehicleId = generateId("vehicle");
    await db.insert(schema.vehicleProfiles).values({ id: freshVehicleId, ownerUserId, label: "No-mileage-yet CR-V", make: "Honda", model: "CR-V", year: 2024 });
    const rule: RecurrenceRule = { kind: "mileage_or_calendar", intervalMonths: 3, intervalMiles: 5000, vehicleProfileId: freshVehicleId, baselineMileage: 0 };
    const { id } = await schedule.createTask(ownerUserId, { title: "First service (time or mileage)", dueIso: "2026-06-15T00:00:00.000Z", recurrenceRule: rule });
    createdTaskIds.push(id);

    await schedule.completeTask(id, ownerUserId);

    const [row] = await db.select().from(schema.tasks).where(eq(schema.tasks.id, id));
    expect(row!.state).toBe("completed"); // no reading to re-anchor to — behaves like a one-off task
    await db.delete(schema.vehicleProfiles).where(eq(schema.vehicleProfiles.id, freshVehicleId));
  });
});
