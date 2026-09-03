import { useEffect, useSyncExternalStore } from "react";

/**
 * §42.6 "Offline sync and conflict model" — apps/mobile had two read-only offline caches
 * (trip-offline-cache.ts, emergency-binder-cache.ts) but nothing for the other half of that section: "an
 * encrypted local store caches ... pending mutations" and "offline command receives a client-generated
 * command/idempotency ID and remains visibly Pending until server confirms." Before this file, a mutation
 * attempted with no network just threw straight out of api-client.ts's `request()` with no recovery path.
 *
 * This module is deliberately split into two halves:
 *   1. `createOfflineMutationQueue()` — pure queue logic (persist/enqueue/drain/conflict handling), taking
 *      its storage and network-execution as injected dependencies. Zero imports of react-native/expo
 *      anything, so it can be constructed and exercised directly under plain Node in a unit test (see
 *      offline-mutation-queue.test.ts) without needing a React Native runtime, Metro, or a test framework
 *      dependency this app doesn't already have.
 *   2. The `offlineMutationQueue` singleton below it, wired to the real AsyncStorage-backed persistence and
 *      the real HTTP executor (registered by api-client.ts via `configureExecutor`). Both of those real
 *      dependencies are loaded with a dynamic `import()` *inside* the functions that need them, never as a
 *      static top-of-file `import` — a static `import ... from "react-native"` (or from
 *      "@react-native-async-storage/async-storage", which pulls in react-native's NativeModules) crashes
 *      immediately under plain Node with a syntax error (confirmed live: `require("react-native")` throws
 *      "Unexpected token 'typeof'" — react-native's own source isn't valid platform-JS without Metro's
 *      Babel transform in front of it). Keeping those imports lazy is what makes half (1) truly testable
 *      without dragging in a whole RN/Metro test environment.
 */

export type MutationMethod = "POST" | "PUT" | "PATCH" | "DELETE";
export type MutationStatus = "pending" | "syncing" | "failed" | "synced";

export interface QueuedMutation {
  /** Client-generated command/idempotency ID (spec §42.6) — stable across every replay attempt of this
   * same mutation, so a future server-side idempotency-key check (mirroring the deterministic-key dedup
   * AutomationService.triggerRun already does for a different subsystem — see services/api/src/modules/
   * automation/automation.service.ts's own doc comment) can be added without any client-side change. */
  id: string;
  method: MutationMethod;
  path: string;
  body: unknown;
  createdAtIso: string;
  status: MutationStatus;
  /** How many times a replay has actually been attempted (network-failure retries included). */
  attempts: number;
  /** Set once a replay gets a real, non-retryable response from the server (see `drain()`'s doc comment on
   * why `network_failure` and `rejected` outcomes are handled completely differently). */
  lastError: string | null;
  /** True when `lastError` came from a 404/409/410 — the record this mutation was about to touch was
   * deleted or changed shape server-side while this device was offline. Spec §42.6: "high-impact ...
   * require review when conflicting" — surfaced to the user rather than silently dropped or blindly
   * retried forever against a target that will never accept it. */
  conflict: boolean;
  /** Human-readable label for a "Queued — will sync" UI badge, e.g. "Mark handled". */
  description: string;
}

export interface QueueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

/** What actually happened when the queue tried to send one mutation to the server — the one distinction
 * this whole module exists to make: a real answer from the server (`rejected`, even a 4xx/5xx) is never
 * confused with "no answer at all" (`network_failure`). Only the latter is a reason to keep retrying. */
export type ExecuteOutcome = { outcome: "success"; data: unknown } | { outcome: "rejected"; status: number; message: string } | { outcome: "network_failure" };

export interface QueueExecutor {
  (mutation: Pick<QueuedMutation, "id" | "method" | "path" | "body">): Promise<ExecuteOutcome>;
}

export interface EnqueueInput {
  method: MutationMethod;
  path: string;
  body: unknown;
  description: string;
}

export interface OfflineMutationQueue {
  /** Loads persisted state into memory. Safe to call repeatedly (a no-op after the first successful call);
   * every other method calls this itself, so app code only needs it directly for an eager warm-up. */
  hydrate(): Promise<void>;
  enqueue(input: EnqueueInput): Promise<QueuedMutation>;
  list(): Promise<QueuedMutation[]>;
  /** Synchronous snapshot for `useSyncExternalStore` — returns the same array reference until something
   * actually changes, per that hook's contract. */
  getSnapshot(): QueuedMutation[];
  subscribe(listener: () => void): () => void;
  /** Replays every "pending" entry, in enqueue order, against the real endpoint. At most one drain runs at
   * a time (see its own doc comment) — safe to call from multiple triggers (app foreground, a just-succeeded
   * unrelated request, a manual "Retry sync" button) without risking the same entry being sent twice
   * concurrently. */
  drain(): Promise<void>;
  /** Removes one entry outright — for a user dismissing a "failed"/conflicted mutation they've decided not
   * to retry (e.g. after reviewing a conflict). */
  discard(id: string): Promise<void>;
  /** Moves a "failed" entry back to "pending" and immediately drains — for a user tapping "Try again". */
  retry(id: string): Promise<void>;
  /** Wipes the whole queue. Called on sign-out (auth-context.tsx), mirroring trip-offline-cache.ts's and
   * emergency-binder-cache.ts's identical clear-on-signout precedent: a mutation queued under one account
   * must never be replayed under a different account that later signs in on the same device. Unlike those
   * two read caches, there's no separate ownerUserId-tag defense-in-depth here — a queued mutation is only
   * ever replayed through api-client.ts's own `request()`, which attaches whatever session is CURRENT at
   * replay time, so even a missed clear() fails safe-ish (wrong-account application, not a silent
   * cross-account data leak into the UI) rather than failing open. */
  clear(): Promise<void>;
}

const STORAGE_KEY = "veynlo_offline_mutation_queue_v1";
// A transient server error (5xx) gets a few automatic retries on later drains before giving up and asking
// the user to look at it — matches the "bounded retry" shape §42.5 requires of short jobs, applied here to
// a client-originated one.
const MAX_TRANSIENT_RETRY_ATTEMPTS = 5;

/** Mirrors packages/core/src/util/ids.ts's `randomToken` (16 random bytes, hex-encoded) but kept as a local
 * copy rather than imported: that function is gated behind a closed `IdKind` union of server-recognized ID
 * prefixes, and this command ID is a client-only concept the server never needs to parse — extending that
 * shared union for one mobile-only concept isn't worth the cross-package coupling. */
function generateCommandId(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return `cmd_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function createOfflineMutationQueue(deps: { storage: QueueStorage; execute: QueueExecutor }): OfflineMutationQueue {
  let entries: QueuedMutation[] = [];
  let hydrated: Promise<void> | null = null;
  let draining: Promise<void> | null = null;
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of listeners) listener();
  }

  async function persist(): Promise<void> {
    // Best-effort, same stance as trip-offline-cache.ts/emergency-binder-cache.ts: a failed write here
    // shouldn't crash the mutation that's already succeeded/failed in memory — worst case this entry's
    // final state doesn't survive an app kill, same risk profile as any other unflushed local write.
    try {
      await deps.storage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch {
      // ignore — see comment above
    }
  }

  function hydrateOnce(): Promise<void> {
    if (!hydrated) {
      hydrated = (async () => {
        try {
          const raw = await deps.storage.getItem(STORAGE_KEY);
          entries = raw ? (JSON.parse(raw) as QueuedMutation[]) : [];
        } catch {
          entries = [];
        }
        // A "syncing" entry on load means the app process died mid-request (killed, crashed, force-quit) —
        // whether the request actually reached the server is unknown. Reset to "pending" so it's retried
        // on the next drain rather than stuck forever in a state nothing ever transitions out of.
        entries = entries.map((entry) => (entry.status === "syncing" ? { ...entry, status: "pending" as const } : entry));
        notify();
      })();
    }
    return hydrated;
  }

  async function updateEntry(id: string, patch: Partial<QueuedMutation>): Promise<void> {
    entries = entries.map((entry) => (entry.id === id ? { ...entry, ...patch } : entry));
    await persist();
    notify();
  }

  async function removeEntry(id: string): Promise<void> {
    entries = entries.filter((entry) => entry.id !== id);
    await persist();
    notify();
  }

  async function enqueue(input: EnqueueInput): Promise<QueuedMutation> {
    await hydrateOnce();
    const mutation: QueuedMutation = {
      id: generateCommandId(),
      method: input.method,
      path: input.path,
      body: input.body,
      createdAtIso: new Date().toISOString(),
      status: "pending",
      attempts: 0,
      lastError: null,
      conflict: false,
      description: input.description,
    };
    entries = [...entries, mutation];
    await persist();
    notify();
    return mutation;
  }

  async function list(): Promise<QueuedMutation[]> {
    await hydrateOnce();
    return entries;
  }

  function getSnapshot(): QueuedMutation[] {
    return entries;
  }

  function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function drain(): Promise<void> {
    // One drain loop at a time, and calling drain() again while one is already running just awaits the
    // SAME in-flight run rather than starting a second one — the real, fixable double-apply risk this
    // queue guards against isn't "the network response came back after the server had already applied it"
    // (that needs server-side idempotency-key support this task doesn't touch — see the `id` field's doc
    // comment), it's "two independent triggers (app-foreground + a just-succeeded unrelated request +
    // a manual retry button) all call drain() around the same moment and each replay the same pending
    // entry." A shared in-flight promise makes that structurally impossible rather than relying on timing.
    if (draining) return draining;
    draining = (async () => {
      await hydrateOnce();
      // Snapshot which ids to attempt this pass, in enqueue order — §42.6 doesn't mandate strict ordering,
      // but replaying anything out of order risks e.g. a "check this list item" landing before the "add
      // this list item" that was queued first for the very same not-yet-created row.
      const idsThisPass = entries.filter((entry) => entry.status === "pending").map((entry) => entry.id);
      for (const id of idsThisPass) {
        const current = entries.find((entry) => entry.id === id);
        if (!current || current.status !== "pending") continue; // already handled (or never pending) — skip
        await updateEntry(id, { status: "syncing" });
        const result = await deps.execute({ id: current.id, method: current.method, path: current.path, body: current.body });
        if (result.outcome === "success") {
          await removeEntry(id);
          continue;
        }
        if (result.outcome === "network_failure") {
          // Still offline (or dropped again mid-drain) — stop this whole pass rather than churning through
          // the rest of the queue one network error at a time; the next trigger (foreground, a later
          // successful request, the poll in OfflineMutationQueueDrain) starts a fresh pass from scratch.
          await updateEntry(id, { status: "pending", attempts: current.attempts + 1 });
          break;
        }
        // A real response came back — see this file's top doc comment and ExecuteOutcome's own comment for
        // why this is never treated as "try again automatically" the way a network_failure is.
        const isConflict = result.status === 404 || result.status === 409 || result.status === 410;
        if (result.status >= 500 && current.attempts + 1 < MAX_TRANSIENT_RETRY_ATTEMPTS) {
          // Transient server error — worth trying again on a LATER drain (not immediately in a tight loop),
          // and worth moving on to the rest of this pass right now instead of stalling on one bad id.
          await updateEntry(id, { status: "pending", attempts: current.attempts + 1, lastError: result.message });
          continue;
        }
        await updateEntry(id, { status: "failed", attempts: current.attempts + 1, lastError: result.message, conflict: isConflict });
      }
    })();
    try {
      await draining;
    } finally {
      draining = null;
    }
  }

  async function discard(id: string): Promise<void> {
    await hydrateOnce();
    await removeEntry(id);
  }

  async function retry(id: string): Promise<void> {
    await hydrateOnce();
    await updateEntry(id, { status: "pending", conflict: false, lastError: null });
    await drain();
  }

  async function clear(): Promise<void> {
    entries = [];
    hydrated = Promise.resolve();
    await persist();
    notify();
  }

  return { hydrate: hydrateOnce, enqueue, list, getSnapshot, subscribe, drain, discard, retry, clear };
}

// ---------------------------------------------------------------------------------------------------------
// Real singleton — AsyncStorage-backed persistence, HTTP execution registered by api-client.ts. Everything
// below is deliberately excluded from the pure logic above so offline-mutation-queue.test.ts can exercise
// that logic without any of this ever loading.
// ---------------------------------------------------------------------------------------------------------

let executor: QueueExecutor | null = null;

/** Called once by api-client.ts at module load — see that file for why the actual HTTP call (and the
 * network-failure-vs-real-rejection classification) lives there instead of being duplicated here. */
export function configureExecutor(fn: QueueExecutor): void {
  executor = fn;
}

let singleton: OfflineMutationQueue | null = null;

function realQueue(): OfflineMutationQueue {
  if (!singleton) {
    singleton = createOfflineMutationQueue({
      storage: {
        async getItem(key) {
          const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
          return AsyncStorage.getItem(key);
        },
        async setItem(key, value) {
          const { default: AsyncStorage } = await import("@react-native-async-storage/async-storage");
          await AsyncStorage.setItem(key, value);
        },
      },
      execute: async (mutation) => {
        if (!executor) {
          // Should be unreachable in the real app (api-client.ts configures this at its own module load,
          // before any screen could possibly call enqueue/drain) — fails loudly rather than silently
          // dropping a mutation if that wiring is ever accidentally removed.
          throw new Error("offline-mutation-queue: no executor configured — api-client.ts must call configureExecutor() at load time");
        }
        return executor(mutation);
      },
    });
  }
  return singleton;
}

/** The queue app code actually uses. Every method just forwards to the lazily-constructed real queue above
 * — none of them touch AsyncStorage/the executor until actually called, so merely importing this module
 * (as offline-mutation-queue.test.ts does, to reach `createOfflineMutationQueue` instead) never does. */
export const offlineMutationQueue: OfflineMutationQueue = {
  hydrate: () => realQueue().hydrate(),
  enqueue: (input) => realQueue().enqueue(input),
  list: () => realQueue().list(),
  getSnapshot: () => realQueue().getSnapshot(),
  subscribe: (listener) => realQueue().subscribe(listener),
  drain: () => realQueue().drain(),
  discard: (id) => realQueue().discard(id),
  retry: (id) => realQueue().retry(id),
  clear: () => realQueue().clear(),
};

/** Reactive view over the queue for UI — e.g. a "Queued — will sync" badge that needs to know the moment an
 * entry syncs (disappears) or fails. `entries` is `[]` until `hydrate()` resolves (kicked off below), which
 * is the correct initial state: nothing pending is known yet, not an error. */
export function useOfflineMutationQueue(): { entries: QueuedMutation[]; pendingCount: number } {
  const entries = useSyncExternalStore(offlineMutationQueue.subscribe, offlineMutationQueue.getSnapshot, offlineMutationQueue.getSnapshot);
  useEffect(() => {
    offlineMutationQueue.hydrate();
  }, []);
  const pendingCount = entries.filter((entry) => entry.status === "pending" || entry.status === "syncing").length;
  return { entries, pendingCount };
}

/** Convenience for a screen tracking one queued mutation by the idempotency key `api.postQueueable`/
 * `putQueueable` handed back — `undefined` once it's synced (removed) just as much as before it was ever
 * queued, so callers distinguish those two by whatever local flag they set when they got a `queued` result. */
export function useQueuedMutation(idempotencyKey: string | null | undefined): QueuedMutation | undefined {
  const { entries } = useOfflineMutationQueue();
  return idempotencyKey ? entries.find((entry) => entry.id === idempotencyKey) : undefined;
}
