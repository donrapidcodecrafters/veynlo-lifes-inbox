import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { PlaidAdapter } from "./plaid.adapter";
import { CredentialVault } from "../../common/credential-vault";
import { recordConnectorSyncFailure } from "./connection-health.util";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * §43.3 "Connection health model" — proves the actual fix against a real connector's real thrown errors
 * (not a synthetic Error object): a simulated 429/`RATE_LIMIT_EXCEEDED` response from Plaid's
 * `/transactions/sync` sets `rate_limited` (not the old generic `degraded`), and — §43.3's own "auto-
 * recovers... rather than needing manual reset" requirement — a subsequent successful sync clears it back
 * to `healthy` via that success path's own unconditional health write (PlaidAdapter.syncTransactions).
 * Separately, a simulated `ITEM_LOGIN_REQUIRED` (Plaid's real, documented "user must reconnect" error code)
 * sets `reauth_required`.
 *
 * `recordConnectorSyncFailure` is called directly here (rather than through a live BullMQ worker process)
 * for the same reason `connectors.pause.test.ts` calls `ConnectorsService` methods directly — it's the
 * exact function worker-main.ts's connectorSyncWorker catch-all calls on a thrown sync error, extracted
 * specifically so it's unit-testable without spinning up Redis/BullMQ.
 */
process.env.PLAID_CLIENT_ID = "test-plaid-client-id";
process.env.PLAID_SECRET = "test-plaid-secret";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

const stubEntitlements = { assertConnectorQuota: async () => {}, resolveHistoricalBackfillDays: async () => 90 } as unknown as EntitlementsService;
const stubQueue = { enqueueConnectorSync: async () => {} } as unknown as QueueProducer;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("§43.3 connection health classification — real provider errors from PlaidAdapter", () => {
  let db: Database;
  let plaid: PlaidAdapter;
  let ownerUserId: string;
  let dbAvailable = true;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const vault = new CredentialVault(db);
    plaid = new PlaidAdapter(db, vault, stubEntitlements, stubQueue);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `health-test-${ownerUserId}@example.com`, displayName: "Health Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping connection-health adapter tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** Establishes a real, healthy Plaid connection via the adapter's own exchange + initial sync — same
   * setup every plaid.adapter.test.ts case uses — so the rate-limit/reauth cases below start from a
   * realistic "already connected and healthy" state, not a hand-inserted row. */
  async function connectHealthyPlaidConnection(accountId: string): Promise<string> {
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/item/public_token/exchange")) return jsonResponse({ access_token: `access-${accountId}`, item_id: `item-${accountId}` });
      if (url.includes("/accounts/get")) {
        return jsonResponse({
          accounts: [
            {
              account_id: accountId,
              name: "Test Checking",
              official_name: "Test Bank Checking",
              type: "depository",
              subtype: "checking",
              mask: "0000",
              balances: { current: 100, available: 100, iso_currency_code: "USD" },
            },
          ],
        });
      }
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) return jsonResponse({ added: [], modified: [], removed: [], next_cursor: "cursor-initial", has_more: false });
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    const { connectionId } = await plaid.exchangePublicToken({ publicToken: `public-${accountId}`, ownerUserId, householdId: null });
    await plaid.initialSync(connectionId);
    return connectionId;
  }

  it("a simulated rate-limit response sets rate_limited (not generic degraded), and a subsequent successful sync clears it back to healthy", async () => {
    if (!dbAvailable) return;
    const connectionId = await connectHealthyPlaidConnection(generateId("financialAccount"));

    const [beforeRow] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(beforeRow?.health).toBe("healthy");

    // Simulate Plaid rate-limiting the next sync attempt.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/accounts/get")) return jsonResponse({ accounts: [] });
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) return jsonResponse({ error_code: "RATE_LIMIT_EXCEEDED", error_type: "RATE_LIMIT_EXCEEDED" }, 429);
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    let thrown: unknown;
    try {
      await plaid.incrementalSync(connectionId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const classified = await recordConnectorSyncFailure(db, connectionId, thrown, "plaid");
    expect(classified.health).toBe("rate_limited");

    const [rateLimitedRow] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(rateLimitedRow?.health).toBe("rate_limited");
    expect(rateLimitedRow?.healthDetail).toMatch(/rate-limit/i);

    // §43.3 "auto-recovers... rather than needing manual reset" — the connection must actually be eligible
    // for the next scan tick (previously the eligibility query only ever allowed health = "healthy", which
    // would have left a rate_limited connection permanently stuck).
    const { ConnectorsService } = await import("./connectors.service");
    const connectors = new ConnectorsService(db, stubQueue, {} as never, plaid, new CredentialVault(db));
    const eligible = await connectors.listEligibleForIncrementalScan();
    expect(eligible.map((c) => c.id)).toContain(connectionId);

    // Next successful sync clears it back to healthy — no manual reset needed.
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/accounts/get")) return jsonResponse({ accounts: [] });
      if (url.includes("/liabilities/get")) return jsonResponse({ liabilities: { credit: null, mortgage: null, student: null } });
      if (url.includes("/transactions/sync")) return jsonResponse({ added: [], modified: [], removed: [], next_cursor: "cursor-recovered", has_more: false });
      throw new Error(`Unexpected fetch in test: ${url}`);
    });
    await plaid.incrementalSync(connectionId);

    const [recoveredRow] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(recoveredRow?.health).toBe("healthy");

    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });

  it("a simulated invalid-grant / ITEM_LOGIN_REQUIRED failure sets reauth_required", async () => {
    if (!dbAvailable) return;
    const connectionId = await connectHealthyPlaidConnection(generateId("financialAccount"));

    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/accounts/get")) return jsonResponse({ error_code: "ITEM_LOGIN_REQUIRED", error_type: "ITEM_ERROR" }, 400);
      throw new Error(`Unexpected fetch in test: ${url}`);
    });

    let thrown: unknown;
    try {
      await plaid.incrementalSync(connectionId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeDefined();
    const classified = await recordConnectorSyncFailure(db, connectionId, thrown, "plaid");
    expect(classified.health).toBe("reauth_required");

    const [row] = await db.select().from(schema.connections).where(eq(schema.connections.id, connectionId));
    expect(row?.health).toBe("reauth_required");

    // §43.3 "Stop unauthorized fetches" — a reauth_required connection must NOT be picked up by the
    // recurring incremental-scan tick again until the user actually reconnects.
    const { ConnectorsService } = await import("./connectors.service");
    const connectors = new ConnectorsService(db, stubQueue, {} as never, plaid, new CredentialVault(db));
    const eligible = await connectors.listEligibleForIncrementalScan();
    expect(eligible.map((c) => c.id)).not.toContain(connectionId);

    await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
  });
});
