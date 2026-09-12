// Node's built-in test runner (`node --test`, Node >=20) with its native TypeScript type-stripping —
// deliberately not jest/vitest: apps/mobile had no unit-test setup at all before this file (`"test": "echo
// 'no-op'"` in package.json), and this repo's pnpm workspace scope for this task is apps/mobile only, so
// adding a test-framework dependency here would mean regenerating the ROOT pnpm-lock.yaml, outside that
// scope. Node's own runner needs nothing new installed and already ships with this toolchain (confirmed:
// `node --version` here is v24, which strips TS types by default).
//
// This file `require()`s offline-mutation-queue.ts's CommonJS interop rather than using an ESM `import` —
// verified experimentally that Node's type-stripping handles `export`/`import` syntax inside a required
// `.ts` file fine under the default (no "type": "module" in package.json) CommonJS interpretation, whereas
// an ESM-mode `import` of a plain `.ts` sibling needs a "type": "module" this app's package.json
// deliberately doesn't set (Metro/Expo, not Node, resolves this app's real modules).
//
// Only `createOfflineMutationQueue` is exercised — the pure, dependency-injected half of the module (see
// its own top doc comment). The real AsyncStorage/HTTP-backed singleton is never touched here.
//
/* eslint-disable @typescript-eslint/no-require-imports -- deliberate: this suite runs under `tsx --test`,
   i.e. Node's own test runner rather than a bundler, and loads the module under test through CommonJS on
   purpose. Rewriting these as ESM imports would change what is actually being exercised. */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createOfflineMutationQueue,
}: typeof import("./offline-mutation-queue") = require("./offline-mutation-queue.ts");
import type { ExecuteOutcome, QueueExecutor, QueueStorage, QueuedMutation } from "./offline-mutation-queue";

/** In-memory stand-in for AsyncStorage — persists exactly like the real thing (a single JSON blob under one
 * key), just without touching disk, so "restart the app" is simply "construct a second queue against the
 * same FakeStorage instance." */
function createFakeStorage(): QueueStorage {
  const data = new Map<string, string>();
  return {
    async getItem(key) {
      return data.has(key) ? data.get(key)! : null;
    },
    async setItem(key, value) {
      data.set(key, value);
    },
  };
}

/** A scriptable executor: each call consumes the next queued response (or falls back to `network_failure`
 * once exhausted), and every call is recorded so tests can assert exactly how many times — and in what
 * order — the queue actually tried to send something. */
function createFakeExecutor() {
  const calls: Array<{ id: string; method: string; path: string; body: unknown }> = [];
  const responses: ExecuteOutcome[] = [];
  const execute: QueueExecutor = async (mutation) => {
    calls.push({ id: mutation.id, method: mutation.method, path: mutation.path, body: mutation.body });
    return responses.shift() ?? { outcome: "network_failure" };
  };
  return { execute, calls, responses };
}

test("enqueue persists a pending entry with a unique client-generated idempotency id", async () => {
  const storage = createFakeStorage();
  const { execute } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });

  const a = await queue.enqueue({ method: "POST", path: "/v1/attention/att_1/resolve", body: undefined, description: "Mark handled" });
  const b = await queue.enqueue({ method: "POST", path: "/v1/lists/lst_1/items", body: { label: "Milk" }, description: 'Add "Milk"' });

  assert.equal(a.status, "pending");
  assert.match(a.id, /^cmd_[0-9a-f]{32}$/);
  assert.notEqual(a.id, b.id);

  const persisted = JSON.parse((await storage.getItem("veynlo_offline_mutation_queue_v1"))!) as QueuedMutation[];
  assert.equal(persisted.length, 2);
  assert.deepEqual(
    persisted.map((e) => e.path),
    ["/v1/attention/att_1/resolve", "/v1/lists/lst_1/items"],
  );
});

test("hydrate reloads a persisted queue into a fresh instance (survives an app restart)", async () => {
  const storage = createFakeStorage();
  const first = createOfflineMutationQueue({ storage, execute: createFakeExecutor().execute });
  await first.enqueue({ method: "PUT", path: "/v1/lists/items/sav_1", body: { checked: true }, description: "Mark checked" });

  // A brand-new queue instance against the SAME storage — simulates the app process being killed and
  // relaunched, which is exactly when this matters: nothing about `first` survives, only what got persisted.
  const second = createOfflineMutationQueue({ storage, execute: createFakeExecutor().execute });
  const entries = await second.list();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "/v1/lists/items/sav_1");
  assert.equal(entries[0].status, "pending");
});

test("hydrate resets a stuck 'syncing' entry back to pending (an app kill mid-request must not orphan it)", async () => {
  const storage = createFakeStorage();
  await storage.setItem(
    "veynlo_offline_mutation_queue_v1",
    JSON.stringify([
      { id: "cmd_stuck", method: "POST", path: "/v1/x", body: undefined, createdAtIso: new Date().toISOString(), status: "syncing", attempts: 1, lastError: null, conflict: false, description: "x" },
    ]),
  );
  const queue = createOfflineMutationQueue({ storage, execute: createFakeExecutor().execute });
  const entries = await queue.list();
  assert.equal(entries[0].status, "pending");
});

test("drain replays a pending entry and removes it once the server actually confirms success", async () => {
  const storage = createFakeStorage();
  const { execute, calls, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  const mutation = await queue.enqueue({ method: "POST", path: "/v1/attention/att_1/resolve", body: undefined, description: "Mark handled" });

  responses.push({ outcome: "success", data: { ok: true } });
  await queue.drain();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, mutation.id);
  assert.deepEqual(await queue.list(), []);
  const persisted = JSON.parse((await storage.getItem("veynlo_offline_mutation_queue_v1"))!);
  assert.deepEqual(persisted, []);
});

test("drain on a network failure leaves the entry pending, does NOT mark it failed, and stops the rest of the pass", async () => {
  const storage = createFakeStorage();
  const { execute, calls, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  await queue.enqueue({ method: "POST", path: "/v1/attention/att_1/resolve", body: undefined, description: "first" });
  await queue.enqueue({ method: "POST", path: "/v1/attention/att_2/resolve", body: undefined, description: "second" });

  responses.push({ outcome: "network_failure" });
  await queue.drain();

  const entries = await queue.list();
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, "pending");
  assert.equal(entries[0].attempts, 1);
  // The second entry was never even attempted — still offline, no point burning through the rest of the
  // queue one network error at a time.
  assert.equal(entries[1].attempts, 0);
  assert.equal(calls.length, 1);
});

test("drain on a 409 marks the entry failed+conflict and never resends it on a later drain (spec §42.6 conflict review)", async () => {
  const storage = createFakeStorage();
  const { execute, calls, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  await queue.enqueue({ method: "PUT", path: "/v1/lists/items/sav_1", body: { checked: true }, description: "Mark checked" });

  responses.push({ outcome: "rejected", status: 409, message: "This item changed." });
  await queue.drain();

  let entries = await queue.list();
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].conflict, true);
  assert.equal(entries[0].lastError, "This item changed.");
  assert.equal(calls.length, 1);

  // A second drain() must NOT replay a "failed" entry automatically — that's the queue's actual
  // never-double-apply guarantee: once an entry is off "pending", nothing about drain() touches it again
  // without an explicit user-initiated retry().
  await queue.drain();
  assert.equal(calls.length, 1);
  entries = await queue.list();
  assert.equal(entries[0].status, "failed");
});

test("a non-conflict 4xx (e.g. validation) is marked failed without the conflict flag", async () => {
  const storage = createFakeStorage();
  const { execute, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  await queue.enqueue({ method: "POST", path: "/v1/lists/lst_1/items", body: { label: "" }, description: "Add" });

  responses.push({ outcome: "rejected", status: 400, message: "Label is required." });
  await queue.drain();

  const entries = await queue.list();
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].conflict, false);
});

test("a transient 5xx is retried automatically up to the retry cap, then gives up", async () => {
  const storage = createFakeStorage();
  const { execute, calls, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  await queue.enqueue({ method: "POST", path: "/v1/attention/att_1/resolve", body: undefined, description: "x" });

  // MAX_TRANSIENT_RETRY_ATTEMPTS is 5 — five 500s exhaust it, the sixth drain must not attempt again.
  for (let i = 0; i < 5; i++) {
    responses.push({ outcome: "rejected", status: 503, message: "Service unavailable." });
    await queue.drain();
  }
  const entries = await queue.list();
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[0].attempts, 5);
  assert.equal(calls.length, 5);

  await queue.drain();
  assert.equal(calls.length, 5); // no sixth attempt — it's "failed", not "pending", after the cap
});

test("retry() moves a failed entry back to pending and immediately re-attempts it", async () => {
  const storage = createFakeStorage();
  const { execute, calls, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  const mutation = await queue.enqueue({ method: "PUT", path: "/v1/lists/items/sav_1", body: { checked: true }, description: "x" });

  responses.push({ outcome: "rejected", status: 409, message: "conflict" });
  await queue.drain();
  assert.equal((await queue.list())[0].status, "failed");

  responses.push({ outcome: "success", data: {} });
  await queue.retry(mutation.id);

  assert.deepEqual(await queue.list(), []);
  assert.equal(calls.length, 2);
});

test("discard() removes an entry outright regardless of status", async () => {
  const storage = createFakeStorage();
  const { execute, responses } = createFakeExecutor();
  const queue = createOfflineMutationQueue({ storage, execute });
  const mutation = await queue.enqueue({ method: "POST", path: "/v1/x", body: undefined, description: "x" });
  responses.push({ outcome: "rejected", status: 404, message: "not found" });
  await queue.drain();
  assert.equal((await queue.list())[0].status, "failed");

  await queue.discard(mutation.id);
  assert.deepEqual(await queue.list(), []);
});

test("clear() wipes every entry and persists the empty state", async () => {
  const storage = createFakeStorage();
  const queue = createOfflineMutationQueue({ storage, execute: createFakeExecutor().execute });
  await queue.enqueue({ method: "POST", path: "/v1/a", body: undefined, description: "a" });
  await queue.enqueue({ method: "POST", path: "/v1/b", body: undefined, description: "b" });

  await queue.clear();

  assert.deepEqual(await queue.list(), []);
  const persisted = JSON.parse((await storage.getItem("veynlo_offline_mutation_queue_v1"))!);
  assert.deepEqual(persisted, []);
});

test("concurrent drain() calls never send the same pending entry twice (the real double-apply risk this queue guards against)", async () => {
  const storage = createFakeStorage();
  const calls: string[] = [];
  let releaseFirstCall: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    releaseFirstCall = resolve;
  });
  const execute: QueueExecutor = async (mutation) => {
    calls.push(mutation.id);
    await gate; // block the in-flight attempt until the test says to proceed
    return { outcome: "success", data: {} };
  };
  const queue = createOfflineMutationQueue({ storage, execute });
  const mutation = await queue.enqueue({ method: "POST", path: "/v1/attention/att_1/resolve", body: undefined, description: "x" });

  const firstDrain = queue.drain();
  const secondDrain = queue.drain(); // fired before the first has resolved anything at all
  releaseFirstCall!();
  await Promise.all([firstDrain, secondDrain]);

  assert.deepEqual(calls, [mutation.id]); // exactly one send, not two
  assert.deepEqual(await queue.list(), []);
});
