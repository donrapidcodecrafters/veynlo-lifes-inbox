import { describe, expect, it, vi } from "vitest";
import { IcsAdapter } from "./ics.adapter";
import { SafeUrlFetcher } from "../ingestion/safe-url-fetcher";
import type { Database } from "@veynlo/db";
import type { CredentialVault } from "../../common/credential-vault";
import type { IngestionService } from "../ingestion/ingestion.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * IcsAdapter used to fetch a user-supplied feed URL via node-ical's own `fromURL`, which is a bare
 * `fetch()` with default redirect-following and zero IP-range validation — an unguarded, recurring SSRF
 * primitive (see IngestionModule/ConnectorsModule audit trail in ics.adapter.ts's own doc comment). This
 * proves the fix: `connect()` now goes through the real SafeUrlFetcher (the same SSRF guard
 * `safe-url-fetcher.test.ts` unit-tests at the IP-range level) and must refuse a URL that resolves to a
 * private/loopback/link-local address — including the cloud metadata address — *before* ever touching the
 * database, rather than silently making the request.
 */
describe("IcsAdapter — SSRF guard on the feed URL", () => {
  function makeAdapter() {
    const db = {
      insert: vi.fn(() => {
        throw new Error("must not reach the DB — the SSRF-guarded fetch should have thrown first");
      }),
    } as unknown as Database;
    const vault = {} as CredentialVault;
    const ingestion = {} as IngestionService;
    const queue = { enqueueConnectorSync: vi.fn() } as unknown as QueueProducer;
    return new IcsAdapter(db, vault, ingestion, new SafeUrlFetcher(), queue);
  }

  it("refuses a feed URL pointing at loopback", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.connect({ dto: { url: "http://127.0.0.1:9/feed.ics" }, ownerUserId: "u_test", householdId: null }),
    ).rejects.toMatchObject({ response: { code: "URL_UNREACHABLE" } });
  });

  it("refuses a feed URL pointing at the cloud instance-metadata address", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.connect({ dto: { url: "http://169.254.169.254/latest/meta-data/" }, ownerUserId: "u_test", householdId: null }),
    ).rejects.toMatchObject({ response: { code: "URL_UNREACHABLE" } });
  });

  it("refuses a non-http(s) scheme outright", async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.connect({ dto: { url: "file:///etc/passwd" }, ownerUserId: "u_test", householdId: null }),
    ).rejects.toMatchObject({ response: { code: "UNSUPPORTED_URL_SCHEME" } });
  });
});
