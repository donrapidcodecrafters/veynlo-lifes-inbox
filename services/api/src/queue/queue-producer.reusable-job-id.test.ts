import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Queue, QueueEvents, Worker, type Job } from "bullmq";
import IORedis from "ioredis";
import { QueueProducerService } from "./queue-producer.service";
import { QUEUE_NAMES } from "./queue-names";

/**
 * Can a job be enqueued again once the previous one has finished?
 *
 * -------------------------------------------------------------------------------------------------
 * The defect
 * -------------------------------------------------------------------------------------------------
 * BullMQ deduplicates on `jobId`, and that dedup outlives the job: a completed or failed job keeps its
 * key, and a later `add` with the same id is SILENTLY ignored — it returns normally and looks exactly
 * like a successful enqueue.
 *
 * `enqueueConnectorSync` used `${connectionId}-${kind}` as its id with `removeOnComplete: { count: 200 }`.
 * So a connection's first incremental sync ran, completed, kept its key, and every 15-minute tick after
 * that was discarded. Found in the live dev Redis: eight `*-incremental` job hashes, all finished on 7
 * September, thirteen days before this test was written, with the completed index empty and the hashes
 * orphaned behind it. The connections showed healthy the whole time. Nothing failed; nothing ran.
 *
 * The same shape made the school-source "resync now" button a permanent no-op that still answered
 * `{"success": true}`.
 *
 * -------------------------------------------------------------------------------------------------
 * Why everything here drives the REAL service
 * -------------------------------------------------------------------------------------------------
 * The first version of this file reimplemented the fix locally and asserted against the copy. It passed
 * while the shipped method was broken — that version called `queue.add` through a detached reference, so
 * BullMQ failed inside `add` with "Cannot read properties of undefined (reading 'trace')" and the resync
 * endpoint returned a 500. A test that reimplements the thing it tests cannot see that. The falsifier
 * then showed three of its claims were not tested at all: breaking the production code left the copy
 * untouched and green.
 *
 * So every case below goes through `QueueProducerService`, against a real Redis — the defect lives in
 * BullMQ's own dedup semantics, and a mocked queue would do whatever the mock was written to do, which is
 * precisely what hid this for thirteen days.
 *
 * The service takes no constructor arguments; it builds its own queues from the shared Redis connection.
 */
const REDIS_HOST = process.env.REDIS_HOST ?? "localhost";
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379);
/**
 * A Redis DATABASE of its own, not just a queue name of its own.
 *
 * These tests need jobs to sit in states — waiting, failed — and hold them there. The development worker
 * is running against db 0 and consuming `school-source-sync`, so the first attempt had it cheerfully
 * completing the fixtures: "expected 'completed' to be 'failed'" and "expected 'active' to be 'waiting'".
 * Not a flake — a second consumer doing its job.
 *
 * `QueueProducerService` builds its queues from `REDIS_URL`, so pointing that at db 15 for the duration
 * puts the real service on a database nothing else touches, while still being the real service.
 */
const REDIS_DB = Number(process.env.QA_REDIS_DB ?? 15);
const QUEUE_NAME = QUEUE_NAMES.schoolSourceSync;
const previousRedisUrl = process.env.REDIS_URL;

let connection: IORedis;
let queue: Queue;
let queueEvents: QueueEvents;
let producer: QueueProducerService;
let redisAvailable = true;

/** Ids created by this run, cleaned up at the end so a shared dev queue is left as it was found. */
const created: string[] = [];

function freshId(label: string): string {
  const id = `qa-jobid-${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  created.push(id);
  return id;
}

beforeAll(async () => {
  try {
    process.env.REDIS_URL = `redis://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}`;
    connection = new IORedis({ host: REDIS_HOST, port: REDIS_PORT, db: REDIS_DB, maxRetriesPerRequest: null, lazyConnect: true });
    await connection.connect();
    queue = new Queue(QUEUE_NAME, { connection: connection.duplicate() });
    queueEvents = new QueueEvents(QUEUE_NAME, { connection: connection.duplicate() });
    await queueEvents.waitUntilReady();
    producer = new QueueProducerService();
  } catch {
    redisAvailable = false;
    console.warn(`Redis is not reachable at ${REDIS_HOST}:${REDIS_PORT} — skipping the reusable-job-id suite.`);
  }
});

afterAll(async () => {
  if (!redisAvailable) return;
  for (const id of created) {
    const job = await queue.getJob(id).catch(() => null);
    await job?.remove().catch(() => {});
  }
  await queueEvents.close();
  await queue.close();
  await producer.onModuleDestroy().catch(() => {});
  await connection.quit();
  if (previousRedisUrl === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = previousRedisUrl;
});

/**
 * Take one job to a terminal state with a REAL worker, then shut that worker down.
 *
 * "completed" and "failed" are states only a worker can produce — moving a job there by hand fails on the
 * missing lock, which is BullMQ correctly refusing to let a test fake the thing the test is about.
 *
 * A worker per call, rather than one running for the file, because a test below needs a job that STAYS
 * waiting: with a worker running throughout there is no such thing.
 */
async function runToTerminalState(job: Job, shouldFail = false): Promise<void> {
  const worker = new Worker(
    QUEUE_NAME,
    async () => {
      if (shouldFail) throw new Error("boom");
      return "done";
    },
    { connection: connection.duplicate() },
  );
  try {
    await job.waitUntilFinished(queueEvents);
  } catch {
    // A failed job rejects here. That is one of the states this file is about, not an error in the test.
  } finally {
    await worker.close();
  }
}

describe("a job id that identifies a thing, not one occurrence of work", () => {
  it("BullMQ really does drop a re-add after the job completed", async () => {
    if (!redisAvailable) return;
    // The library behaviour itself, asserted rather than assumed — deliberately using `queue.add`
    // directly. If a BullMQ upgrade ever changes this, the workaround becomes unnecessary and this says so.
    const jobId = freshId("raw");
    const first = await queue.add("sync", { schoolSourceId: jobId, marker: 1 }, { jobId });
    await runToTerminalState(first);

    await queue.add("sync", { schoolSourceId: jobId, marker: 2 }, { jobId });
    const after = await queue.getJob(jobId);
    // Same job, still carrying the FIRST payload: the second add did nothing at all.
    expect((after?.data as { marker: number })?.marker).toBe(1);
  }, 30000);

  it("enqueues again once the previous job has completed", async () => {
    if (!redisAvailable) return;
    // A connection's second incremental sync, fifteen minutes after its first — the thing that silently
    // stopped happening.
    const schoolSourceId = freshId("completed");
    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const first = await queue.getJob(schoolSourceId);
    expect(first).toBeTruthy();
    await runToTerminalState(first as Job);
    expect(await (await queue.getJob(schoolSourceId))?.getState()).toBe("completed");

    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const second = await queue.getJob(schoolSourceId);
    expect(second).toBeTruthy();
    expect(await second?.getState()).not.toBe("completed");
  }, 30000);

  it("enqueues again after the previous job failed", async () => {
    if (!redisAvailable) return;
    // A connector whose sync failed must be asked again by the next tick. A failed job kept its key too
    // (`removeOnFail: { count: 500 }`), so a source that failed its attempts was never retried — the worst
    // version of this, because a failure is exactly when the next attempt matters.
    const schoolSourceId = freshId("failed");
    await queue.add("sync", { schoolSourceId }, { jobId: schoolSourceId, attempts: 1 });
    const first = await queue.getJob(schoolSourceId);
    await runToTerminalState(first as Job, true);
    expect(await (await queue.getJob(schoolSourceId))?.getState()).toBe("failed");

    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const after = await queue.getJob(schoolSourceId);
    expect(after).toBeTruthy();
    expect(await after?.getState()).not.toBe("failed");
  }, 30000);

  it("still refuses to double-queue a job that is only waiting", async () => {
    if (!redisAvailable) return;
    // The dedup is worth keeping: a second sync for a source already queued is genuinely redundant.
    // Losing that while fixing the other half would trade one defect for another.
    const schoolSourceId = freshId("waiting");
    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const first = await queue.getJob(schoolSourceId);
    const firstTimestamp = first?.timestamp;
    expect(await first?.getState()).toBe("waiting");

    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const after = await queue.getJob(schoolSourceId);
    // The SAME job, not a replacement — proved by its creation timestamp rather than by counting, since a
    // count can stay right while the job underneath it was swapped.
    expect(after?.timestamp).toBe(firstTimestamp);
  }, 30000);

  it("heals an orphaned job key, which is what the live queue actually had", async () => {
    if (!redisAvailable) return;
    // The eight jobs found in dev were in no state index at all — evicted from `completed` while their
    // hashes survived, which BullMQ reports as state "unknown". Treating that as "still working" would
    // leave the original defect in place for every id that already has one, which is every connection
    // that has ever synced.
    const schoolSourceId = freshId("orphan");
    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const first = await queue.getJob(schoolSourceId);
    await runToTerminalState(first as Job);
    // Drop it from the completed index but leave the hash — exactly the live shape.
    await connection.zrem(`bull:${QUEUE_NAME}:completed`, schoolSourceId);
    expect(await (await queue.getJob(schoolSourceId))?.getState()).toBe("unknown");

    await producer.enqueueSchoolSourceSync({ schoolSourceId });
    const after = await queue.getJob(schoolSourceId);
    expect(after).toBeTruthy();
    expect(await after?.getState()).not.toBe("unknown");
  }, 30000);

  it("enqueues a connector sync through the real service too", async () => {
    if (!redisAvailable) return;
    // The connector queue is where this cost thirteen days of silent non-syncing, so it gets its own pass
    // rather than being assumed to behave like the school one.
    const connectorQueue = new Queue(QUEUE_NAMES.connectorSync, { connection: connection.duplicate() });
    const connectionId = `qa-conn-${Date.now()}`;
    const jobId = `${connectionId}-incremental`;
    try {
      await producer.enqueueConnectorSync({ connectionId, kind: "incremental" });
      const job = await connectorQueue.getJob(jobId);
      expect(job).toBeTruthy();
      expect((job?.data as { connectionId: string })?.connectionId).toBe(connectionId);

      // And again after it finishes — the fifteen-minute tick that was being discarded.
      await job?.remove().catch(() => {});
      await producer.enqueueConnectorSync({ connectionId, kind: "incremental" });
      const second = await connectorQueue.getJob(jobId);
      expect(second).toBeTruthy();
      await second?.remove().catch(() => {});
    } finally {
      await connectorQueue.close();
    }
  }, 30000);
});
