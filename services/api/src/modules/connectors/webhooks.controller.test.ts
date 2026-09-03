import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { WebhooksController, _setGoogleJwksForTests } from "./webhooks.controller";
import { PlaidAdapter } from "./plaid.adapter";
import { CredentialVault } from "../../common/credential-vault";
import { loadEnv } from "../../config/env";
import { hashWebhookSecret, verifyGmailPushToken } from "./webhook-verification";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";

/**
 * §43 CONN-001 "Webhook endpoint verifies provider/channel signature/secret... enqueues processing" — for
 * every one of the three receivers, a valid signature must enqueue the SAME incremental-sync job polling
 * already uses, and an invalid one must be rejected with NO side effect (no enqueue, no DB write) — proven
 * here against real cryptographic verification (a locally generated RSA/EC keypair standing in for each
 * provider's real signing key, with no network call to Google/Plaid's real endpoints), not a placeholder
 * check.
 */
process.env.PLAID_CLIENT_ID = "test-plaid-client-id";
process.env.PLAID_SECRET = "test-plaid-secret";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/** Returns `state` itself (not a destructured snapshot) — `send()`/`header()` mutate it in place, so a
 * caller must read `state.body`/`state.header` AFTER awaiting the controller call, not before. */
function fakeReply(): { reply: FastifyReply; state: { header: Record<string, string>; body: unknown } } {
  const state: { header: Record<string, string>; body: unknown } = { header: {}, body: undefined };
  const reply = {
    header(name: string, value: string) {
      state.header[name] = value;
      return reply;
    },
    send(body: unknown) {
      state.body = body;
      return reply;
    },
  } as unknown as FastifyReply;
  return { reply, state };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("WebhooksController — real signature verification per provider", () => {
  let db: Database;
  let controller: WebhooksController;
  let plaid: PlaidAdapter;
  let enqueued: { connectionId: string; kind: string }[];
  let ownerUserId: string;
  let dbAvailable = true;
  const originalFetch = global.fetch;

  const stubEntitlements = { assertConnectorQuota: async () => {}, resolveHistoricalBackfillDays: async () => 90 } as unknown as EntitlementsService;

  beforeAll(async () => {
    db = createDbClient(DATABASE_URL);
    const vault = new CredentialVault(db);
    const spyQueue: QueueProducer = {
      enqueueConnectorSync: async (data: { connectionId: string; kind: string }) => {
        enqueued.push(data);
      },
    } as unknown as QueueProducer;
    plaid = new PlaidAdapter(db, vault, stubEntitlements, spyQueue);
    controller = new WebhooksController(db, spyQueue, plaid);
    try {
      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `webhook-test-${ownerUserId}@example.com`, displayName: "Webhook Test" });
    } catch (err) {
      dbAvailable = false;
      console.warn("Skipping WebhooksController tests — no reachable dev Postgres:", (err as Error).message);
    }
  });

  afterAll(async () => {
    if (dbAvailable) {
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
  });

  beforeEach(() => {
    enqueued = [];
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  async function makeConnection(provider: string): Promise<string> {
    const connectionId = generateId("connection");
    await db.insert(schema.connections).values({ id: connectionId, ownerUserId, provider, feasibilityClass: "direct_api", health: "healthy" });
    return connectionId;
  }

  describe("Gmail — Pub/Sub push OIDC token verification", () => {
    it("verifies a real RS256-signed, correctly issued/audienced token and rejects a wrong-audience one — pure verification logic", async () => {
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "gmail-test-key";
      jwk.alg = "RS256";
      const jwks = createLocalJWKSet({ keys: [jwk] });
      const audience = `${loadEnv().API_PUBLIC_URL}/v1/webhooks/gmail`;

      const validToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "gmail-test-key" })
        .setIssuedAt()
        .setIssuer("https://accounts.google.com")
        .setAudience(audience)
        .setExpirationTime("10m")
        .sign(privateKey);
      await expect(verifyGmailPushToken(validToken, audience, jwks)).resolves.toBeDefined();

      const wrongAudienceToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "gmail-test-key" })
        .setIssuedAt()
        .setIssuer("https://accounts.google.com")
        .setAudience("https://someone-elses-deployment.example.com/v1/webhooks/gmail")
        .setExpirationTime("10m")
        .sign(privateKey);
      await expect(verifyGmailPushToken(wrongAudienceToken, audience, jwks)).rejects.toThrow();

      const wrongIssuerToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "gmail-test-key" })
        .setIssuedAt()
        .setIssuer("https://not-google.example.com")
        .setAudience(audience)
        .setExpirationTime("10m")
        .sign(privateKey);
      await expect(verifyGmailPushToken(wrongIssuerToken, audience, jwks)).rejects.toThrow();
    });

    it("a valid push token routes to the matching connection and enqueues an incremental sync; an invalid one is rejected with no side effect", async () => {
      if (!dbAvailable) return;
      const { publicKey, privateKey } = await generateKeyPair("RS256");
      const jwk = await exportJWK(publicKey);
      jwk.kid = "gmail-test-key-2";
      jwk.alg = "RS256";
      _setGoogleJwksForTests(createLocalJWKSet({ keys: [jwk] }));
      const audience = `${loadEnv().API_PUBLIC_URL}/v1/webhooks/gmail`;

      const connectionId = await makeConnection("gmail");
      const mailbox = `user-${connectionId}@example.com`;
      await db.insert(schema.webhookSubscriptions).values({
        id: generateId("webhookSubscription"),
        connectionId,
        provider: "gmail",
        externalId: mailbox,
      });

      const pushData = Buffer.from(JSON.stringify({ emailAddress: mailbox, historyId: "12345" })).toString("base64");

      const validToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "gmail-test-key-2" })
        .setIssuedAt()
        .setIssuer("https://accounts.google.com")
        .setAudience(audience)
        .setExpirationTime("10m")
        .sign(privateKey);
      const validResult = await controller.gmail(`Bearer ${validToken}`, { message: { data: pushData } });
      expect(validResult).toEqual({ received: true, routed: true });
      expect(enqueued).toEqual([{ connectionId, kind: "incremental" }]);

      // Invalid signature (a completely unrelated key) — must be rejected with zero side effect.
      enqueued.length = 0;
      const { privateKey: attackerKey } = await generateKeyPair("RS256");
      const forgedToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "gmail-test-key-2" })
        .setIssuedAt()
        .setIssuer("https://accounts.google.com")
        .setAudience(audience)
        .setExpirationTime("10m")
        .sign(attackerKey);
      const invalidResult = await controller.gmail(`Bearer ${forgedToken}`, { message: { data: pushData } });
      expect(invalidResult).toEqual({ received: false });
      expect(enqueued).toEqual([]);

      await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.connectionId, connectionId));
      await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
    });
  });

  describe("Microsoft Graph — validation handshake + clientState verification", () => {
    it("echoes the validationToken verbatim as text/plain for the subscription handshake", async () => {
      const { reply, state } = fakeReply();
      await controller.microsoft("handshake-token-abc", {}, reply);
      expect(state.header["content-type"]).toBe("text/plain");
      expect(state.body).toBe("handshake-token-abc");
    });

    it("a notification with the correct clientState enqueues an incremental sync; a wrong clientState is rejected with no side effect", async () => {
      if (!dbAvailable) return;
      const connectionId = await makeConnection("outlook");
      const clientStateSecret = "a-high-entropy-secret-this-app-generated";
      await db.insert(schema.webhookSubscriptions).values({
        id: generateId("webhookSubscription"),
        connectionId,
        provider: "microsoft",
        externalId: "graph-subscription-id-1",
        channelSecretHash: hashWebhookSecret(clientStateSecret),
      });

      const { reply: validReply, state: validState } = fakeReply();
      await controller.microsoft(undefined, { value: [{ subscriptionId: "graph-subscription-id-1", clientState: clientStateSecret }] }, validReply);
      expect(validState.body).toEqual({ received: true, routed: 1 });
      expect(enqueued).toEqual([{ connectionId, kind: "incremental" }]);

      enqueued.length = 0;
      const { reply: invalidReply, state: invalidState } = fakeReply();
      await controller.microsoft(undefined, { value: [{ subscriptionId: "graph-subscription-id-1", clientState: "wrong-secret" }] }, invalidReply);
      expect(invalidState.body).toEqual({ received: true, routed: 0 });
      expect(enqueued).toEqual([]);

      await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.connectionId, connectionId));
      await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
    });
  });

  describe("Plaid — ES256 JWS + raw-body-hash verification", () => {
    async function signedPlaidRequest(
      privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"],
      kid: string,
      itemId: string,
    ): Promise<{ header: string; rawBody: Buffer }> {
      const rawBody = Buffer.from(JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId }));
      const bodyHash = createHash("sha256").update(rawBody).digest("hex");
      const header = await new SignJWT({ request_body_sha256: bodyHash })
        .setProtectedHeader({ alg: "ES256", kid })
        .setIssuedAt()
        .sign(privateKey);
      return { header, rawBody };
    }

    it("a validly signed webhook (matching Plaid's real /webhook_verification_key/get flow) routes to the matching connection and enqueues an incremental sync", async () => {
      if (!dbAvailable) return;
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const jwk = await exportJWK(publicKey);
      const kid = "plaid-test-key-1";
      jwk.kid = kid;
      jwk.alg = "ES256";

      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async (url: string, init?: { body?: string }) => {
        if (url.includes("/webhook_verification_key/get")) {
          const requested = init?.body ? (JSON.parse(init.body) as { key_id?: string }).key_id : undefined;
          expect(requested).toBe(kid);
          return jsonResponse({ key: { ...jwk, expired_at: null } });
        }
        throw new Error(`Unexpected fetch in test: ${url}`);
      });

      const connectionId = await makeConnection("plaid");
      const itemId = `item-${connectionId}`;
      await db.insert(schema.webhookSubscriptions).values({ id: generateId("webhookSubscription"), connectionId, provider: "plaid", externalId: itemId });

      const { header, rawBody } = await signedPlaidRequest(privateKey, kid, itemId);
      const fakeReq = { rawBody } as unknown as FastifyRequest;
      const result = await controller.plaidWebhook(header, fakeReq, JSON.parse(rawBody.toString()));
      expect(result).toEqual({ received: true, routed: true });
      expect(enqueued).toEqual([{ connectionId, kind: "incremental" }]);

      await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.connectionId, connectionId));
      await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
    });

    it("rejects a webhook whose body was tampered with after signing — the signature covers the exact raw bytes — with no side effect", async () => {
      if (!dbAvailable) return;
      const { publicKey, privateKey } = await generateKeyPair("ES256");
      const jwk = await exportJWK(publicKey);
      const kid = "plaid-test-key-2";
      jwk.kid = kid;
      jwk.alg = "ES256";

      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      fetchMock.mockImplementation(async (url: string) => {
        if (url.includes("/webhook_verification_key/get")) return jsonResponse({ key: { ...jwk, expired_at: null } });
        throw new Error(`Unexpected fetch in test: ${url}`);
      });

      const connectionId = await makeConnection("plaid");
      const itemId = `item-${connectionId}`;
      await db.insert(schema.webhookSubscriptions).values({ id: generateId("webhookSubscription"), connectionId, provider: "plaid", externalId: itemId });

      const { header, rawBody } = await signedPlaidRequest(privateKey, kid, itemId);
      // Tamper with the body AFTER signing — same header, different bytes; `request_body_sha256` no longer matches.
      const tamperedBody = Buffer.from(rawBody.toString().replace(itemId, `${itemId}-tampered`));
      const fakeReq = { rawBody: tamperedBody } as unknown as FastifyRequest;
      const result = await controller.plaidWebhook(header, fakeReq, JSON.parse(tamperedBody.toString()));
      expect(result).toEqual({ received: false });
      expect(enqueued).toEqual([]);

      await db.delete(schema.webhookSubscriptions).where(eq(schema.webhookSubscriptions.connectionId, connectionId));
      await db.delete(schema.connections).where(eq(schema.connections.id, connectionId));
    });
  });
});
