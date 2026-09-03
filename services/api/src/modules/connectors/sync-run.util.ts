import { and, desc, eq, ne } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";

/**
 * §42.5 "Historical backfill: chunked, resumable, rate-limited, user-visible progress" — the shared
 * resumability primitive used by `gmail.adapter.ts` and `outlook.adapter.ts`'s `initialSync` (the same
 * chunked-backfill shape; a future connector's own multi-page backfill can reuse this unchanged).
 *
 * Previously `initialSync` wrote `connections.cursor`/`itemsDiscoveredCount` exactly once, after the ENTIRE
 * multi-page backfill finished — so a job that died mid-backfill (a process restart, an OOM, a crash)
 * always resumed via BullMQ's retry calling `initialSync` again from scratch, redoing every page no matter
 * how far the previous attempt had gotten. `sync_runs` is now the actual resumability record: one row per
 * backfill attempt, with `pagesCompleted`/`itemsProcessed`/`checkpoint` updated after EVERY page.
 */
export interface BackfillRun {
  id: string;
  itemsProcessed: number;
  pagesCompleted: number;
  /** The provider's own page-token/continuation-link as of the last completed page — `undefined` (not
   * `null`) when there's nothing to resume from yet, matching the `pageToken?: string` shape
   * `gmail.adapter.ts`/`outlook.adapter.ts`'s existing pagination loops already use. */
  checkpoint: string | undefined;
}

/**
 * Finds the most recent NOT-YET-`completed` `initial_backfill` run for this connection to resume, or starts
 * a brand-new one. A run stuck at `status: "running"` forever (a hard process kill mid-page never gets the
 * chance to write anything else) is just as resumable as one this method itself marked `"failed"` after a
 * handled exception — both are picked up here identically, since neither ever reached `"completed"`.
 */
export async function findOrCreateBackfillRun(db: Database, connectionId: string): Promise<BackfillRun> {
  const [existing] = await db
    .select()
    .from(schema.syncRuns)
    .where(and(eq(schema.syncRuns.connectionId, connectionId), eq(schema.syncRuns.kind, "initial_backfill"), ne(schema.syncRuns.status, "completed")))
    .orderBy(desc(schema.syncRuns.startedAt))
    .limit(1);
  if (existing) {
    return { id: existing.id, itemsProcessed: existing.itemsProcessed, pagesCompleted: existing.pagesCompleted, checkpoint: existing.checkpoint ?? undefined };
  }
  const id = generateId("syncRun");
  await db.insert(schema.syncRuns).values({ id, connectionId, kind: "initial_backfill", status: "running" });
  return { id, itemsProcessed: 0, pagesCompleted: 0, checkpoint: undefined };
}

/** Called after EVERY page (not just the last one) — the whole point of this table's existence. Also
 * mirrors the running item count onto `connections.itemsDiscoveredCount` so backfill progress is visible on
 * the Connections page while `health` is still `"initializing"`, not just once the whole backfill finishes. */
export async function recordBackfillPageProgress(
  db: Database,
  run: BackfillRun,
  connectionId: string,
  itemsProcessed: number,
  checkpoint: string | undefined,
): Promise<void> {
  await db
    .update(schema.syncRuns)
    .set({ itemsProcessed, pagesCompleted: run.pagesCompleted + 1, checkpoint: checkpoint ?? null })
    .where(eq(schema.syncRuns.id, run.id));
  await db.update(schema.connections).set({ itemsDiscoveredCount: itemsProcessed }).where(eq(schema.connections.id, connectionId));
}

export async function completeBackfillRun(db: Database, runId: string): Promise<void> {
  await db.update(schema.syncRuns).set({ status: "completed", completedAt: new Date() }).where(eq(schema.syncRuns.id, runId));
}

/** Leaves `checkpoint`/`pagesCompleted`/`itemsProcessed` exactly where the last successful
 * `recordBackfillPageProgress` call left them — that's what makes the NEXT `findOrCreateBackfillRun` call
 * (the retry BullMQ schedules after this job throws) resume from here instead of restarting. */
export async function failBackfillRun(db: Database, runId: string, err: unknown): Promise<void> {
  await db
    .update(schema.syncRuns)
    .set({ status: "failed", errorDetail: String((err as Error)?.message ?? err) })
    .where(eq(schema.syncRuns.id, runId));
}
