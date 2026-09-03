import { Body, Controller, Headers, HttpCode, Inject, Logger, Post, Query, Req, Res } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createRemoteJWKSet, type JWK, type JWTVerifyGetKey } from "jose";
import { and, eq } from "drizzle-orm";
import { schema, type Database } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv } from "../../config/env";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { PlaidAdapter } from "./plaid.adapter";
import { verifyGmailPushToken, verifyMicrosoftClientState, verifyPlaidWebhook } from "./webhook-verification";

// Google's own public JWKS for verifying Pub/Sub push OIDC tokens — created once at module scope (jose's
// remote JWKS fetcher caches keys internally and only refetches on a `kid` it hasn't seen), not per
// request. `let`, not `const`: `_setGoogleJwksForTests` below overrides it so tests can exercise the real
// verification algorithm (signature/issuer/audience) against a locally generated keypair, with no network
// call to Google's real endpoint — mirrors CredentialVault's `_resetKeyRingForTests` naming convention.
let googleJwks: JWTVerifyGetKey = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));

/** Test-only. See `googleJwks`'s own doc comment. */
export function _setGoogleJwksForTests(jwks: JWTVerifyGetKey): void {
  googleJwks = jwks;
}

interface GmailPushBody {
  message?: { data?: string; messageId?: string; publishTime?: string };
  subscription?: string;
}

interface GraphNotificationBody {
  value?: Array<{ subscriptionId?: string; clientState?: string; resource?: string; changeType?: string }>;
}

/**
 * §43 CONN-001 "Webhook/push + reconciliation" — the RECEIVER side for the three providers this app's
 * connectors can plausibly get push notifications from. Each route's whole job is exactly what CONN-001
 * describes: "verifies provider/channel signature/secret, records event quickly, enqueues processing and
 * acknowledges" — the actual sync work is the SAME `incrementalSync` path the recurring polling tick
 * already drives (QueueProducerService.enqueueConnectorSync, deduped by jobId), not a parallel webhook-only
 * ingestion mechanism, so a push notification's only effect is making sync happen sooner than the next poll.
 *
 * What this does NOT do (and can't, in this dev environment — see docs/PHASE2_PENDING_CREDENTIALS.md):
 * actually REGISTER a subscription with any of these providers. That needs a public HTTPS callback URL
 * this dev environment doesn't have, and for Gmail specifically a real GCP Pub/Sub topic (Gmail's
 * `users.watch` API delivers push notifications via Pub/Sub, not a directly-configured webhook URL — Pub/Sub
 * is what actually calls this endpoint). The verification logic below is real and correct against real
 * provider key material regardless (see webhook-verification.ts's own doc comment); once a deployment has a
 * public URL, wiring up the provider-side `watch`/`subscriptions.create` calls to populate
 * `webhook_subscriptions` rows is the only remaining step.
 */
@Controller("v1/webhooks")
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(PlaidAdapter) private readonly plaid: PlaidAdapter,
  ) {}

  /**
   * Gmail push notifications. Real, documented auth scheme: a Google Cloud Pub/Sub push subscription
   * created with an OIDC `pushConfig` signs a Google-issued ID token into every push's
   * `Authorization: Bearer <token>` header — verified here against Google's real public JWKS with the
   * exact issuer/audience checks Google's own docs specify (see webhook-verification.ts's
   * verifyGmailPushToken). The push payload itself only ever carries the mailbox's `emailAddress` and a
   * `historyId` (never message content — §43 "callback endpoints do not expose user content"), so the
   * actual new mail is fetched by the SAME `history.list`-driven `incrementalSync` polling already uses,
   * just enqueued immediately instead of waiting for the next scan tick.
   */
  @Post("gmail")
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async gmail(@Headers("authorization") authorization: string | undefined, @Body() body: GmailPushBody) {
    const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
    if (!token) {
      this.logger.warn("Rejected Gmail push notification with no Authorization header.");
      return { received: false };
    }

    const audience = `${loadEnv().API_PUBLIC_URL}/v1/webhooks/gmail`;
    try {
      await verifyGmailPushToken(token, audience, googleJwks);
    } catch (err) {
      this.logger.warn(`Rejected Gmail push notification with an invalid token: ${String(err)}`);
      return { received: false };
    }

    const dataB64 = body.message?.data;
    if (!dataB64) return { received: true, routed: false };
    let emailAddress: string | undefined;
    try {
      const decoded = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8")) as { emailAddress?: string };
      emailAddress = decoded.emailAddress;
    } catch {
      return { received: true, routed: false };
    }
    if (!emailAddress) return { received: true, routed: false };

    const connectionId = await this.findConnectionId("gmail", emailAddress);
    if (!connectionId) {
      this.logger.warn(`Gmail push notification for an unrecognized mailbox — no matching webhook subscription.`);
      return { received: true, routed: false };
    }

    await this.queue.enqueueConnectorSync({ connectionId, kind: "incremental" });
    return { received: true, routed: true };
  }

  /**
   * Microsoft Graph change notifications. Two distinct request shapes hit this one URL, exactly as Graph's
   * own docs describe:
   *  1. The subscription create/renew validation handshake — a request carrying a `validationToken` query
   *     param, which must be echoed back verbatim as `text/plain` with a 200 within 10 seconds and nothing
   *     else (no auth check needed here — this handshake IS how Graph proves it can reach this URL at all).
   *  2. A real notification batch (`{value: [...]}`), each item carrying the `clientState` secret this app
   *     chose when creating that subscription — checked here against `webhook_subscriptions.channelSecretHash`
   *     (see webhook-verification.ts's verifyMicrosoftClientState) since Graph has no per-request signature.
   * One Microsoft-family connection (outlook/microsoft_calendar/onedrive/microsoft_todo) subscribes
   * separately per resource, so a notification batch can legitimately span several connections at once.
   */
  @Post("microsoft")
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async microsoft(
    @Query("validationToken") validationToken: string | undefined,
    @Body() body: GraphNotificationBody,
    @Res() res: FastifyReply,
  ) {
    if (validationToken !== undefined) {
      // §CONN-001 "records event quickly... acknowledges" — this specific response has to be an exact,
      // unwrapped echo, so it bypasses Nest's default JSON serialization.
      return res.header("content-type", "text/plain").send(validationToken);
    }

    let routedCount = 0;
    for (const item of body.value ?? []) {
      const subscriptionId = item.subscriptionId;
      if (!subscriptionId) continue;
      const subscription = await this.findSubscription("microsoft", subscriptionId);
      if (!subscription) {
        this.logger.warn("Microsoft Graph notification for an unrecognized subscriptionId — no matching webhook subscription.");
        continue;
      }
      if (!verifyMicrosoftClientState(item.clientState, subscription.channelSecretHash)) {
        this.logger.warn(`Rejected Microsoft Graph notification for connection ${subscription.connectionId} — clientState mismatch.`);
        continue; // no side effect for an unverified item — never enqueues a sync off an unverified notification
      }
      await this.queue.enqueueConnectorSync({ connectionId: subscription.connectionId, kind: "incremental" });
      routedCount += 1;
    }
    return res.send({ received: true, routed: routedCount });
  }

  /**
   * Plaid webhooks. Real, documented auth scheme: a compact ES256 JWS in the `Plaid-Verification` header,
   * verified against a key Plaid publishes per-`kid` at `/webhook_verification_key/get`
   * (PlaidAdapter.getWebhookVerificationKey) — see webhook-verification.ts's verifyPlaidWebhook for the
   * full signature/freshness/body-hash checks. Needs the untouched raw request bytes (`req.rawBody`, teed
   * by main.ts's `preParsing` hook for this exact route) since the signed payload hashes the raw body
   * rather than embedding it.
   */
  @Post("plaid")
  @HttpCode(200)
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async plaidWebhook(@Headers("plaid-verification") verificationHeader: string | undefined, @Req() req: FastifyRequest, @Body() body: { item_id?: string }) {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(body ?? {}));
    const result = await verifyPlaidWebhook(rawBody, verificationHeader, (keyId) => this.resolvePlaidKey(keyId));
    if (!result.valid) {
      this.logger.warn(`Rejected Plaid webhook: ${result.reason}`);
      return { received: false };
    }

    const itemId = body?.item_id;
    if (!itemId) return { received: true, routed: false };

    const connectionId = await this.findConnectionId("plaid", itemId);
    if (!connectionId) {
      this.logger.warn("Plaid webhook for an unrecognized item_id — no matching webhook subscription.");
      return { received: true, routed: false };
    }

    await this.queue.enqueueConnectorSync({ connectionId, kind: "incremental" });
    return { received: true, routed: true };
  }

  private async findConnectionId(provider: string, externalId: string): Promise<string | null> {
    const subscription = await this.findSubscription(provider, externalId);
    return subscription?.connectionId ?? null;
  }

  private async findSubscription(
    provider: string,
    externalId: string,
  ): Promise<{ connectionId: string; channelSecretHash: string | null } | null> {
    const [subscription] = await this.db
      .select({ connectionId: schema.webhookSubscriptions.connectionId, channelSecretHash: schema.webhookSubscriptions.channelSecretHash })
      .from(schema.webhookSubscriptions)
      .where(and(eq(schema.webhookSubscriptions.provider, provider), eq(schema.webhookSubscriptions.externalId, externalId)))
      .limit(1);
    return subscription ?? null;
  }

  // Small process-local cache of Plaid's webhook verification keys, keyed by `kid` — Plaid documents these
  // as safe (and expected) to cache rather than re-fetched on every single webhook.
  private readonly plaidKeyCache = new Map<string, JWK>();

  private async resolvePlaidKey(keyId: string): Promise<JWK | null> {
    const cached = this.plaidKeyCache.get(keyId);
    if (cached) return cached;
    const jwk = await this.plaid.getWebhookVerificationKey(keyId);
    if (!jwk) return null;
    const typed = jwk as unknown as JWK;
    this.plaidKeyCache.set(keyId, typed);
    return typed;
  }
}
