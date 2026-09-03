import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import type { GraphMessage } from "../ingestion/outlook-message-parser";
import type { EmailAttachmentInput } from "../ingestion/gmail-message-parser";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";
import { oauthTokenRequestError } from "./connection-health.util";
import { completeBackfillRun, failBackfillRun, findOrCreateBackfillRun, recordBackfillPageProgress } from "./sync-run.util";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const OUTLOOK_SCOPES = ["offline_access", "Mail.Read"];
const MESSAGE_SELECT = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,internetMessageHeaders,hasAttachments";
// Same reasoning/value as GmailAdapter's identical constant — see that file's own doc comment.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** The subset of a Microsoft Graph `fileAttachment` resource this adapter reads — Graph's
 * `/messages/{id}/attachments` list response inlines `contentBytes` (base64) directly for file attachments,
 * unlike Gmail, which needs a second per-part API call (see GmailAdapter.fetchAttachments). A
 * `#microsoft.graph.itemAttachment` (a forwarded Outlook item, not a file) has no `contentBytes` at all and
 * is filtered out below. */
interface GraphAttachment {
  "@odata.type"?: string;
  name?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
  isInline?: boolean | null;
  size?: number | null;
}

interface OutlookCredentials {
  access_token: string;
  refresh_token: string;
}

/**
 * Direct-API connector for Outlook/Microsoft 365 (§12.1, feasibility class
 * A) via the Microsoft Graph API. Uses plain `fetch` + the OAuth2 v2.0
 * token endpoint rather than pulling in an MSAL dependency — the flows
 * involved (authorization code exchange, refresh, delta query) are plain
 * REST/JSON. Mirrors GmailAdapter's shape (authorizationUrl/handleCallback/
 * initialSync/incrementalSync) so worker-main.ts can dispatch to either by
 * `connection.provider` without special-casing.
 */
@Injectable()
export class OutlookAdapter implements OAuthConnectorAdapter {
  private readonly logger = new Logger(OutlookAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("microsoft");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("outlook");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", OUTLOOK_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
    // ONB-002 — see GmailAdapter.handleCallback's identical parameter for why this travels through the
    // signed OAuth `state` rather than being read directly off the callback's own query string.
    requestedHistoryDepthDays?: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("outlook");

    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId, params.requestedHistoryDepthDays);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "outlook",
      feasibilityClass: "direct_api",
      scopes: OUTLOOK_SCOPES,
      enabledCategories: ["purchases", "deliveries", "bills", "subscriptions", "appointments", "documents"],
      health: "initializing",
      historyDepthDays,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.accessToken, refresh_token: tokens.refreshToken },
      tokens.expiresAt,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    // Same durable-job pattern as Gmail (§42.5) — a large mailbox or a process restart mid-sync must not
    // lose progress or leave the OAuth callback hanging.
    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });

    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const afterDate = new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000);
    const filter = `receivedDateTime ge ${afterDate.toISOString()}`;

    // §42.5 "chunked, resumable... user-visible progress" — see GmailAdapter.initialSync's identical
    // wiring / sync-run.util.ts's own doc comment for the full rationale. `run.checkpoint` (a full
    // `@odata.nextLink` URL) resumes a prior interrupted attempt from exactly where it left off instead of
    // restarting the whole date-filtered backfill from page 1.
    const run = await findOrCreateBackfillRun(this.db, connectionId);
    let url = run.checkpoint ?? `${GRAPH_BASE}/me/messages?$select=${MESSAGE_SELECT}&$filter=${encodeURIComponent(filter)}&$top=50&$orderby=receivedDateTime desc`;
    let itemCount = run.itemsProcessed;

    try {
      do {
        const page = await this.graphGet<{ value: GraphMessage[]; "@odata.nextLink"?: string }>(connection, url);
        for (const message of page.value) {
          await this.ingestion.ingestOutlookMessage({
            ownerUserId: connection.ownerUserId,
            householdId: connection.householdId,
            connectionId,
            message,
            attachments: await this.fetchAttachments(connection, message),
            // §47.4 — this whole method is the historical-backfill sync; incrementalSync below never sets this.
            isBackfill: true,
          });
          itemCount += 1;
        }
        url = page["@odata.nextLink"] ?? "";

        // Persisted after EVERY page, not just at the end — see GmailAdapter.initialSync's identical fix.
        await recordBackfillPageProgress(this.db, run, connectionId, itemCount, url || undefined);
        run.pagesCompleted += 1;
      } while (url);
    } catch (err) {
      await failBackfillRun(this.db, run.id, err);
      throw err;
    }

    // Microsoft Graph's delta query (used by incrementalSync below) needs its own starting deltaLink —
    // requesting one now establishes the cursor for everything that changes after this backfill.
    const deltaLink = await this.fetchInitialDeltaLink(connection);

    await completeBackfillRun(this.db, run.id);
    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: itemCount,
        cursor: deltaLink,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /**
   * Real incremental sync (mirrors GmailAdapter.incrementalSync), driven by
   * Microsoft Graph's delta query — each response carries either a
   * `@odata.nextLink` (more pages this round) or a `@odata.deltaLink` (the
   * cursor to resume from next time), stored in `connections.cursor`. If
   * the stored deltaLink has expired (Graph returns 410 Gone), this falls
   * back to a fresh `initialSync` rather than silently going quiet.
   */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    if (!connection.cursor) {
      return this.initialSync(connectionId);
    }

    let itemCount = 0;
    let url = connection.cursor;
    let latestDeltaLink = connection.cursor;

    try {
      do {
        const page = await this.graphGet<{ value: GraphMessage[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(
          connection,
          url,
        );
        for (const message of page.value) {
          await this.ingestion.ingestOutlookMessage({
            ownerUserId: connection.ownerUserId,
            householdId: connection.householdId,
            connectionId,
            message,
            attachments: await this.fetchAttachments(connection, message),
          });
          itemCount += 1;
        }
        if (page["@odata.deltaLink"]) latestDeltaLink = page["@odata.deltaLink"];
        url = page["@odata.nextLink"] ?? "";
      } while (url);
    } catch (err) {
      if ((err as { status?: number }).status === 410) {
        return this.initialSync(connectionId);
      }
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: latestDeltaLink,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async fetchInitialDeltaLink(connection: { credentialRef: string | null }): Promise<string | null> {
    // An empty delta query (no date filter — delta tracks state itself) returns pages of the mailbox's
    // current messages before finally handing back a deltaLink; we only need the deltaLink, so we walk
    // pages without ingesting (the real backfill already happened via the $filter query above).
    let url = `${GRAPH_BASE}/me/mailFolders/inbox/messages/delta?$select=id`;
    let deltaLink: string | null = null;
    let guard = 0;
    while (url && guard < 200) {
      guard += 1;
      const page = await this.graphGet<{ "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
      if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    }
    return deltaLink;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: OUTLOOK_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
      scope: OUTLOOK_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw oauthTokenRequestError("Microsoft", response.status, await response.text());
    }
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return {
      accessToken: json.access_token,
      // Microsoft doesn't always return a new refresh_token on refresh — keep using the prior one if so.
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  /**
   * Fetches `url` with the connection's access token, transparently
   * refreshing and persisting a new token via the vault on a 401 rather
   * than tracking expiry client-side — simpler and just as correct, since
   * a stale token always surfaces as a 401 from Graph.
   */
  private async graphGet<T>(connection: { credentialRef: string | null }, url: string): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as OutlookCredentials;

    let response = await fetch(url, { headers: { authorization: `Bearer ${access_token}` } });
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(
        connection.credentialRef,
        { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken },
        refreshed.expiresAt,
      );
      response = await fetch(url, { headers: { authorization: `Bearer ${refreshed.accessToken}` } });
    }
    if (!response.ok) {
      const err = new Error(`Microsoft Graph request failed: ${response.status} ${await response.text()}`) as Error & { status: number };
      err.status = response.status;
      throw err;
    }
    return response.json() as Promise<T>;
  }

  /**
   * MAIL-004 "Attachment intelligence" — mirrors GmailAdapter.fetchAttachments' role and contract exactly
   * (see that method's doc comment), just against Graph's very different attachment shape: `hasAttachments`
   * is the cheap skip-check, and `/messages/{id}/attachments` inlines base64 `contentBytes` for every
   * `fileAttachment` directly in the list response — no second per-attachment fetch needed the way Gmail
   * requires. Inline attachments (`isInline: true`, e.g. an image referenced by a `cid:` in the HTML body)
   * and non-file attachments (forwarded Outlook items) are both skipped — neither is "an attachment" in the
   * sense MAIL-004 means (an evidence-bearing PDF/image sent alongside the message).
   */
  private async fetchAttachments(connection: { credentialRef: string | null }, message: GraphMessage): Promise<EmailAttachmentInput[]> {
    if (!message.hasAttachments || !message.id) return [];
    try {
      const response = await this.graphGet<{ value: GraphAttachment[] }>(
        connection,
        `${GRAPH_BASE}/me/messages/${message.id}/attachments?$select=name,contentType,contentBytes,isInline,size`,
      );
      const attachments: EmailAttachmentInput[] = [];
      for (const att of response.value) {
        if (att.isInline || !att.contentBytes) continue;
        if (att["@odata.type"] && att["@odata.type"] !== "#microsoft.graph.fileAttachment") continue;
        if ((att.size ?? 0) > MAX_ATTACHMENT_BYTES) continue;
        const buffer = Buffer.from(att.contentBytes, "base64");
        if (buffer.length > MAX_ATTACHMENT_BYTES) continue;
        attachments.push({ filename: att.name ?? "attachment", mimeType: att.contentType ?? "application/octet-stream", buffer });
      }
      return attachments;
    } catch (err) {
      this.logger.warn(`Failed to fetch Outlook attachments for message ${message.id}: ${String(err)}`);
      return [];
    }
  }
}
