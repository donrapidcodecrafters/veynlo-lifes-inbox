import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { TokenTaskAdapter } from "./token-task.adapter";
import { TOKEN_TASK_PROVIDERS } from "./token-task-providers";
import type { Database } from "@veynlo/db";
import type { CredentialVault } from "../../common/credential-vault";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { ScheduleService } from "../schedule/schedule.service";

/**
 * The Todoist/Trello/Asana adapter against a real HTTP server.
 *
 * Not a mocked `fetch`. A stubbed fetch proves the code calls the function it was written to call, which
 * is a tautology; a real server proves the request is actually well-formed — that the token reaches the
 * right place in the right shape, that a rejection is read as a rejection, and that a token is never
 * stored before it has been used successfully at least once.
 *
 * The server below is the only place these tests differ from production: `apiBase` is repointed at it.
 * Everything else — the request construction, the auth, the error handling, the storage — is the code
 * that runs against the real providers.
 */
let server: http.Server;
let base: string;
const originalBases = new Map<string, string>();

/** What the fake providers were last asked, so the request itself can be asserted rather than assumed. */
const seen: { path: string; auth: string | undefined }[] = [];
let todoistStatus = 200;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    seen.push({ path: `${url.pathname}${url.search}`, auth: req.headers.authorization });

    if (url.pathname === "/rest/v2/tasks") {
      if (todoistStatus !== 200) {
        res.writeHead(todoistStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid token" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify([
          { id: "101", content: "Renew passport", due: { date: "2026-03-14" }, is_completed: false },
          { id: "102", content: "Call the dentist", is_completed: false },
        ]),
      );
      return;
    }

    if (url.pathname === "/1/members/me/cards") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ id: "card1", name: "Book the venue", due: "2026-05-01T12:00:00.000Z", dueComplete: false }]));
      return;
    }

    if (url.pathname === "/api/1.0/workspaces") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ gid: "ws1", name: "Personal Projects" }] }));
      return;
    }

    if (url.pathname === "/api/1.0/tasks") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ gid: "t1", name: "File taxes", due_on: "2026-04-15", completed: false }] }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const provider of TOKEN_TASK_PROVIDERS) {
    originalBases.set(provider.key, provider.apiBase);
    provider.apiBase = base;
  }
});

afterAll(async () => {
  // Restored, because TOKEN_TASK_PROVIDERS is module state shared with every other suite in this run.
  for (const provider of TOKEN_TASK_PROVIDERS) provider.apiBase = originalBases.get(provider.key)!;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Records what was written, so "the token was stored" is an observation rather than a hope. */
function harness() {
  const stored: unknown[] = [];
  const enqueued: unknown[] = [];
  const inserted: Record<string, unknown>[] = [];

  const db = {
    insert: () => ({
      values: async (row: Record<string, unknown>) => {
        inserted.push(row);
      },
    }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  } as unknown as Database;

  const vault = {
    store: async (_connectionId: string, creds: unknown) => {
      stored.push(creds);
      return "cred_ref_1";
    },
  } as unknown as CredentialVault;

  const queue = {
    enqueueConnectorSync: async (job: unknown) => {
      enqueued.push(job);
    },
  } as unknown as QueueProducer;

  const schedule = { upsertExternalTask: async () => ({ created: true }) } as unknown as ScheduleService;

  return { adapter: new TokenTaskAdapter(db, vault, queue, schedule), stored, enqueued, inserted };
}

async function connectErrorCode(dto: Record<string, unknown>): Promise<string> {
  const { adapter } = harness();
  try {
    await adapter.connect({ dto: dto as never, ownerUserId: "usr_test", householdId: null });
  } catch (err) {
    const response = (err as { getResponse?: () => unknown })?.getResponse?.();
    if (response && typeof response === "object" && "code" in response) return String((response as { code: unknown }).code);
    return `UNEXPECTED: ${(err as Error)?.message ?? String(err)}`;
  }
  return "NO_ERROR_THROWN";
}

describe("TokenTaskAdapter refuses before it stores anything", () => {
  it("refuses a provider it does not support", async () => {
    // TickTick is OAuth-only. A user who pastes something here must be told no, not have a connection
    // created that can never sync.
    expect(await connectErrorCode({ providerKey: "ticktick", token: "abc" })).toBe("UNKNOWN_TASK_PROVIDER");
  });

  it("refuses an empty token", async () => {
    expect(await connectErrorCode({ providerKey: "todoist", token: "   " })).toBe("TASK_TOKEN_REQUIRED");
  });

  it("refuses Trello without its API key", async () => {
    // Trello is the one provider needing two secrets. Without the key the request would 401, and the user
    // would be told their token was wrong when in fact it was fine.
    expect(await connectErrorCode({ providerKey: "trello", token: "abc" })).toBe("TASK_API_KEY_REQUIRED");
  });

  it("refuses a token the provider rejects", async () => {
    todoistStatus = 401;
    try {
      expect(await connectErrorCode({ providerKey: "todoist", token: "wrong" })).toBe("TASK_CONNECT_FAILED");
    } finally {
      todoistStatus = 200;
    }
  });

  it("stores nothing when the token is rejected", async () => {
    // The assertion that matters. A connection created from an unverified token sits in the user's list
    // reporting healthy and producing nothing — the false "all caught up" the spec forbids.
    todoistStatus = 401;
    const { adapter, stored, inserted, enqueued } = harness();
    try {
      await adapter.connect({ dto: { providerKey: "todoist", token: "wrong" } as never, ownerUserId: "usr_test", householdId: null });
    } catch {
      // expected
    } finally {
      todoistStatus = 200;
    }
    expect(stored).toHaveLength(0);
    expect(inserted).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });
});

describe("TokenTaskAdapter connects", () => {
  it("verifies the token against the provider, then stores it and queues a sync", async () => {
    const { adapter, stored, inserted, enqueued } = harness();
    const result = await adapter.connect({
      dto: { providerKey: "todoist", token: "good-token" } as never,
      ownerUserId: "usr_test",
      householdId: null,
    });

    expect(result.connectionId).toMatch(/^conn/);
    expect(stored).toHaveLength(1);
    expect((stored[0] as { token: string }).token).toBe("good-token");
    expect((inserted[0] as { provider: string }).provider).toBe("todoist");
    expect((inserted[0] as { health: string }).health).toBe("initializing");
    expect(enqueued).toEqual([{ connectionId: result.connectionId, kind: "initial" }]);
  });

  it("sends the Todoist token as a bearer header, not in the URL", async () => {
    // A token in a query string ends up in server logs, proxy logs and browser history. Todoist's API
    // accepts a header; this proves that is what is sent.
    seen.length = 0;
    const { adapter } = harness();
    await adapter.connect({ dto: { providerKey: "todoist", token: "secret-1" } as never, ownerUserId: "u", householdId: null });
    const call = seen.find((c) => c.path.startsWith("/rest/v2/tasks"));
    expect(call?.auth).toBe("Bearer secret-1");
    expect(call?.path).not.toContain("secret-1");
  });

  it("sends both Trello secrets, which that API only accepts as query parameters", async () => {
    seen.length = 0;
    const { adapter } = harness();
    await adapter.connect({
      dto: { providerKey: "trello", token: "t-tok", apiKey: "t-key" } as never,
      ownerUserId: "u",
      householdId: null,
    });
    const call = seen.find((c) => c.path.startsWith("/1/members/me/cards"));
    expect(call?.path).toContain("key=t-key");
    expect(call?.path).toContain("token=t-tok");
    // Archived cards are not open tasks.
    expect(call?.path).toContain("filter=open");
  });

  it("discovers the Asana workspace instead of asking the user for it", async () => {
    seen.length = 0;
    const { adapter } = harness();
    await adapter.connect({ dto: { providerKey: "asana", token: "a-tok" } as never, ownerUserId: "u", householdId: null });
    expect(seen.some((c) => c.path === "/api/1.0/workspaces")).toBe(true);
    const tasks = seen.find((c) => c.path.startsWith("/api/1.0/tasks"));
    expect(tasks?.path).toContain("workspace=ws1");
    expect(tasks?.path).toContain("assignee=me");
    expect(tasks?.auth).toBe("Bearer a-tok");
  });

  it("trims a pasted token, because a copied credential usually carries whitespace", async () => {
    const { adapter, stored } = harness();
    await adapter.connect({ dto: { providerKey: "todoist", token: "  good-token\n" } as never, ownerUserId: "u", householdId: null });
    expect((stored[0] as { token: string }).token).toBe("good-token");
  });
});
