import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { OutlookAdapter } from "./outlook.adapter";
import { CredentialVault } from "../../common/credential-vault";
import type { IngestionService } from "../ingestion/ingestion.service";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * §42.5 "Historical backfill: chunked, resumable" — proves the actual fix: `sync_runs` now persists
 * progress (checkpoint + pages-completed + items-processed) after EVERY page of `initialSync`, not just
 * once at the very end, so a job that dies mid-backfill (a process crash, an OOM kill, a plain network
 * failure) resumes from its last completed page on retry instead of BullMQ's retry re-running the whole
 * backfill from page 1.
 *
 * Exercised via OutlookAdapter rather than GmailAdapter: both call the exact same shared
 * `sync-run.util.ts` primitives (this is the thing actually being fixed), and Outlook's plain-`fetch`-based
 * Graph client is trivially mockable (mirrors plaid.adapter.test.ts's `global.fetch` stubbing), unlike
 * Gmail's `googleapis` client library, which would need a much heavier module mock for the same coverage.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubIngestion = { ingestOutlookMessage: async () => {} } as unknown as IngestionService;
const stubEntitlements = { resolveHistoricalBackfillDays: async () => 90 } as unknown as EntitlementsService;
const stubQueue = { enqueueConnectorSync: async () => {} } as unknown as QueueProducer;

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const PAGE_2_URL = `${GRAPH_BASE}/me/messages?page=2`;
const PAGE_3_URL = `${GRAPH_BASE}/me/messages?page=3`;
const DELTA_URL = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=id`;

function graphMessagePage(id: string, nextLink?: string) {
  return {
    value: [{ id, subject: `Message ${id}`, from: { emailAddress: { address: "sender@example.com" } }, receivedDateTime: new Date().toISOString(), hasAttachments: false }],
    ...(nextLink ? { "@odata.nextLink": nextLink } : {}),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("OutlookAdapter.initialSync — resumable backfill via sync_runs", () => {
  let db: Database;
  let outlook: OutlookAdapter;
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const vault = new CredentialVault(db);
    outlook = new OutlookAdapter(db, vault, stubIngestion, stubQueue, stubEntitlements);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `backfill-resume-${ownerUserId}@example.com`, displayName: "Backfill Resume Test" });
      connectionId = generateId("connection");
      await db.insert(schema.connections).values({
        id: connectionId,
        ownerUserId,
        provider: "outlook",
        feasibilityClass: "direct_api",
        scopes: ["offline_access", "Mail.Read"],
        enabledCategories: ["purchases"],
        health: "initializing",
        historyDepthDays: 90,
      });
      // `connection_credentials.connectionId` FKs to `connections.id`, so the connection row must exist
      // first — same ordering GmailAdapter/OutlookAdapter's own `handleCallback` already uses.
      const credentialRef = await vault.store(connectionId, { access_token: "test-access-token", refresh_token: "test-refresh-token" }, null);
      await db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping OutlookAdapter backfill-resume tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
      const remaining = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.id, ownerUserId));
      expect(remaining).toHaveLength(0);
    }
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("persists a checkpoint after each page, and a retry after an interruption resumes from the next page instead of restarting", async () => {
    if (!dbAvailable) return;

    let page3Attempts = 0;
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    const pageFetchCounts: Record<string, number> = {};
    fetchMock.mockImplementation(async (url: string) => {
      pageFetchCounts[url] = (pageFetchCounts[url] ?? 0) + 1;
      if (url.startsWith(`${GRAPH_BASE}/me/messages?$select=`)) {
        // Page 1 — the initial date-filtered query built fresh (no prior checkpoint).
        return jsonResponse(graphMessagePage("msg-1", PAGE_2_URL));
      }
      if (url === PAGE_2_URL) {
        return jsonResponse(graphMessagePage("msg-2", PAGE_3_URL));
      }
      if (url === PAGE_3_URL) {
        page3Attempts += 1;
        if (page3Attempts === 1) {
          // Simulates the job dying mid-backfill (process crash / network drop) right as page 3 is
          // requested — pages 1 and 2 have ALREADY been checkpointed by this point.
          throw new Error("simulated network failure fetching page 3");
        }
        // The retry's fetch for the same page succeeds — no further pages after this one.
        return jsonResponse(graphMessagePage("msg-3"));
      }
      if (url === DELTA_URL) {
        return jsonResponse({ "@odata.deltaLink": "delta-final" });
      }
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    // --- First attempt: dies partway through page 3 ---
    await expect(outlook.initialSync(connectionId)).rejects.toThrow("simulated network failure fetching page 3");

    const [runAfterFailure] = await db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.connectionId, connectionId), eq(schema.syncRuns.kind, "initial_backfill")));
    expect(runAfterFailure).toBeDefined();
    expect(runAfterFailure?.status).toBe("failed");
    // Exactly the 2 pages that completed before the interruption — not 0, and not silently dropped.
    expect(runAfterFailure?.pagesCompleted).toBe(2);
    expect(runAfterFailure?.itemsProcessed).toBe(2);
    expect(runAfterFailure?.checkpoint).toBe(PAGE_3_URL);

    const [connectionAfterFailure] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    // Still mid-backfill — a failed page doesn't get to flip health to "healthy".
    expect(connectionAfterFailure?.health).toBe("initializing");
    // §Connections page "user-visible progress" — the live count reflects the 2 completed pages already,
    // not 0, even though the backfill as a whole hasn't finished.
    expect(connectionAfterFailure?.itemsDiscoveredCount).toBe(2);

    // --- Retry (what BullMQ's retry policy actually does: calls initialSync again from scratch) ---
    await outlook.initialSync(connectionId);

    // The defining assertion: page 1 and page 2 were fetched exactly ONCE each — the retry did NOT restart
    // from page 1. Page 3 was fetched twice (the failed attempt, then the successful retry).
    const page1Url = Object.keys(pageFetchCounts).find((u) => u.startsWith(`${GRAPH_BASE}/me/messages?$select=`))!;
    expect(pageFetchCounts[page1Url]).toBe(1);
    expect(pageFetchCounts[PAGE_2_URL]).toBe(1);
    expect(pageFetchCounts[PAGE_3_URL]).toBe(2);

    const [runAfterResume] = await db
      .select()
      .from(schema.syncRuns)
      .where(and(eq(schema.syncRuns.connectionId, connectionId), eq(schema.syncRuns.kind, "initial_backfill")));
    expect(runAfterResume?.status).toBe("completed");
    expect(runAfterResume?.pagesCompleted).toBe(3);
    expect(runAfterResume?.itemsProcessed).toBe(3);

    const [connectionAfterResume] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(connectionAfterResume?.health).toBe("healthy");
    expect(connectionAfterResume?.itemsDiscoveredCount).toBe(3);
    expect(connectionAfterResume?.cursor).toBe("delta-final");

    await db.delete(schema.syncRuns).where(eq(schema.syncRuns.connectionId, connectionId));
    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });
});
