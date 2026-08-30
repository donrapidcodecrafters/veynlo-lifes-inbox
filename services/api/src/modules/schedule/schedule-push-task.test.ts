import { describe, expect, it, afterAll, vi } from "vitest";
import { BadRequestException } from "@nestjs/common";
import { generateId } from "@veynlo/core";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { inArray } from "drizzle-orm";
import { HouseholdService } from "../household/household.service";
import { SharingService } from "../shared/sharing.service";
import { ScheduleService } from "./schedule.service";

/**
 * TASK-002 — pushTaskToProvider previously didn't exist at all: tasks could only ever be pulled from
 * Google Tasks/Microsoft To Do, never pushed back, despite the spec calling both "Read/write". Real proof
 * the gap is closed: default provider selection, an explicit destinationProvider override, rejection when
 * the destination isn't connected, and that externalSyncProvider/externalSyncId persist after a push.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";
const db: Database = createDbClient(DATABASE_URL);
const households = new HouseholdService(db, {} as never, {} as never);
const sharing = new SharingService(db);

const createdUserIds: string[] = [];
const createdConnectionIds: string[] = [];
const createdTaskIds: string[] = [];

afterAll(async () => {
  await db.delete(schema.tasks).where(inArray(schema.tasks.id, createdTaskIds));
  await db.delete(schema.connections).where(inArray(schema.connections.id, createdConnectionIds));
  await db.delete(schema.users).where(inArray(schema.users.id, createdUserIds));
});

/** A fresh user per test — each test's "which providers are connected" state must be isolated from every
 * other test's, since a leftover connection from an earlier test would silently change what "not
 * connected" means for a later one. */
async function makeUser(): Promise<string> {
  const id = generateId("user");
  createdUserIds.push(id);
  await db.insert(schema.users).values({ id, displayName: "Push-task Test User" });
  return id;
}

async function makeConnection(ownerId: string, provider: "google_tasks" | "microsoft_todo"): Promise<string> {
  const id = generateId("connection");
  createdConnectionIds.push(id);
  await db.insert(schema.connections).values({ id, ownerUserId: ownerId, provider, feasibilityClass: "direct_api", health: "healthy" });
  return id;
}

async function makeTask(ownerId: string, extra: Partial<typeof schema.tasks.$inferInsert> = {}): Promise<string> {
  const id = generateId("task");
  createdTaskIds.push(id);
  await db.insert(schema.tasks).values({
    id,
    ownerUserId: ownerId,
    title: "Renew passport",
    ...extra,
  });
  return id;
}

function makeService() {
  const googleTasks = { pushTask: vi.fn(async () => ({ providerTaskId: "google_task_1" })) };
  const microsoftTodo = { pushTask: vi.fn(async () => ({ providerTaskId: "ms_task_1" })) };
  const schedule = new ScheduleService(db, households, {} as never, {} as never, googleTasks as never, microsoftTodo as never, sharing);
  return { schedule, googleTasks, microsoftTodo };
}

describe("ScheduleService.pushTaskToProvider — destination selection", () => {
  it("defaults to Google when both are connected and no destination is specified", async () => {
    const { schedule, googleTasks, microsoftTodo } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_tasks");
    await makeConnection(ownerId, "microsoft_todo");
    const taskId = await makeTask(ownerId);

    const result = await schedule.pushTaskToProvider(taskId, ownerId);
    expect(result.provider).toBe("google_tasks");
    expect(googleTasks.pushTask).toHaveBeenCalledTimes(1);
    expect(microsoftTodo.pushTask).not.toHaveBeenCalled();
  });

  it("honors an explicit destinationProvider even when the other provider is also connected", async () => {
    const { schedule, googleTasks, microsoftTodo } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_tasks");
    await makeConnection(ownerId, "microsoft_todo");
    const taskId = await makeTask(ownerId);

    const result = await schedule.pushTaskToProvider(taskId, ownerId, { destinationProvider: "microsoft_todo" });
    expect(result.provider).toBe("microsoft_todo");
    expect(microsoftTodo.pushTask).toHaveBeenCalledTimes(1);
    expect(googleTasks.pushTask).not.toHaveBeenCalled();
  });

  it("rejects an explicit destinationProvider that isn't actually connected", async () => {
    const { schedule } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_tasks");
    const taskId = await makeTask(ownerId);

    await expect(schedule.pushTaskToProvider(taskId, ownerId, { destinationProvider: "microsoft_todo" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects when no tasklist provider is connected at all", async () => {
    const { schedule } = makeService();
    const ownerId = await makeUser();
    const taskId = await makeTask(ownerId);

    await expect(schedule.pushTaskToProvider(taskId, ownerId)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("ScheduleService.pushTaskToProvider — persistence", () => {
  it("persists externalSyncProvider and externalSyncId after a push", async () => {
    const { schedule, googleTasks } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_tasks");
    const taskId = await makeTask(ownerId);

    await schedule.pushTaskToProvider(taskId, ownerId);
    expect(googleTasks.pushTask).toHaveBeenCalledTimes(1);

    const [row] = await db.select().from(schema.tasks).where(inArray(schema.tasks.id, [taskId]));
    expect(row?.externalSyncProvider).toBe("google_tasks");
    expect(row?.externalSyncId).toBe("google_task_1");
  });

  it("reuses the existing externalSyncId as the provider task id only when it already belongs to the destination provider", async () => {
    const { schedule, googleTasks } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_tasks");
    const taskId = await makeTask(ownerId, { externalSyncProvider: "google_tasks", externalSyncId: "existing_google_task" });

    await schedule.pushTaskToProvider(taskId, ownerId);
    expect(googleTasks.pushTask).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ externalSyncId: "existing_google_task" }));
  });

  it("does not reuse an externalSyncId that belongs to a different provider than the push destination", async () => {
    const { schedule, googleTasks } = makeService();
    const ownerId = await makeUser();
    await makeConnection(ownerId, "google_tasks");
    const taskId = await makeTask(ownerId, { externalSyncProvider: "apple_reminders", externalSyncId: "apple-reminder-uuid" });

    await schedule.pushTaskToProvider(taskId, ownerId, { destinationProvider: "google_tasks" });
    expect(googleTasks.pushTask).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ externalSyncId: null }));
  });
});
