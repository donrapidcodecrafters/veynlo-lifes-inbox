import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import type { GraphMessage, GraphAttachment } from "../ingestion/outlook-message-parser";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { ConnectorNotConfiguredError, classifyPermissionHealth, parseGrantedScopes } from "./connector-errors";
import { ConnectorsService } from "./connectors.service";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const OUTLOOK_SCOPES = ["offline_access", "Mail.Read"];
const MESSAGE_SELECT = "id,subject,from,toRecipients,receivedDateTime,bodyPreview,body,internetMessageHeaders,hasAttachments,webLink";

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
export class OutlookAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly ingestion: IngestionService,
    private readonly queue: QueueProducerService,
    private readonly connectors: ConnectorsService,
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
    historyDepthDays: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("outlook");

    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const { connectionId } = await this.connectors.upsertConnectionForConnect({
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "outlook",
      feasibilityClass: "direct_api",
      // What Microsoft actually granted, not what was requested — see classifyPermissionHealth's comment.
      scopes: parseGrantedScopes(tokens.scope),
      enabledCategories: ["purchases", "deliveries", "bills", "subscriptions", "appointments", "documents"],
      historyDepthDays: params.historyDepthDays,
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

  /**
   * MAIL-004 "attachment intelligence" — mirrors GmailAdapter.downloadAttachments. Graph's message list
   * response never inlines attachment bytes (only `hasAttachments`), so a message flagged true gets one
   * follow-up `GET /messages/{id}/attachments` call. Filters to `#microsoft.graph.fileAttachment` only —
   * `itemAttachment` (a forwarded email/contact/event) and `referenceAttachment` (a OneDrive/SharePoint
   * link) have no file bytes to OCR. Best-effort per attachment, same as Gmail's version.
   */
  private async downloadAttachments(connection: { credentialRef: string | null }, messageId: string) {
    const page = await this.graphGet<{ value: GraphAttachment[] }>(connection, `${GRAPH_BASE}/me/messages/${messageId}/attachments`);
    const attachments: Array<{ filename: string; mimeType: string; buffer: Buffer }> = [];
    for (const item of page.value) {
      if (item["@odata.type"] !== "#microsoft.graph.fileAttachment" || !item.contentBytes || !item.name || !item.contentType) continue;
      try {
        attachments.push({ filename: item.name, mimeType: item.contentType, buffer: Buffer.from(item.contentBytes, "base64") });
      } catch {
        // Best-effort — see doc comment above.
      }
    }
    return attachments;
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const afterDate = new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000);
    const filter = `receivedDateTime ge ${afterDate.toISOString()}`;
    let url = `${GRAPH_BASE}/me/messages?$select=${MESSAGE_SELECT}&$filter=${encodeURIComponent(filter)}&$top=50&$orderby=receivedDateTime desc`;

    let itemCount = 0;
    do {
      const page = await this.graphGet<{ value: GraphMessage[]; "@odata.nextLink"?: string }>(connection, url);
      for (const message of page.value) {
        const attachments = message.hasAttachments && message.id ? await this.downloadAttachments(connection, message.id) : [];
        await this.ingestion.ingestOutlookMessage({
          ownerUserId: connection.ownerUserId,
          householdId: connection.householdId,
          connectionId,
          message,
          attachments,
        });
        itemCount += 1;
      }
      url = page["@odata.nextLink"] ?? "";
    } while (url);

    // Microsoft Graph's delta query (used by incrementalSync below) needs its own starting deltaLink —
    // requesting one now establishes the cursor for everything that changes after this backfill.
    const deltaLink = await this.fetchInitialDeltaLink(connection);

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, OUTLOOK_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: itemCount,
        cursor: deltaLink,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
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
          const attachments = message.hasAttachments && message.id ? await this.downloadAttachments(connection, message.id) : [];
          await this.ingestion.ingestOutlookMessage({
            ownerUserId: connection.ownerUserId,
            householdId: connection.householdId,
            connectionId,
            message,
            attachments,
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
        health: classifyPermissionHealth(connection.scopes, OUTLOOK_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: latestDeltaLink,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
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

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
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

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
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

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!response.ok) {
      throw new Error(`Microsoft token request failed: ${response.status} ${await response.text()}`);
    }
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    return {
      accessToken: json.access_token,
      // Microsoft doesn't always return a new refresh_token on refresh — keep using the prior one if so.
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: json.scope,
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
      const err = new Error(`Microsoft Graph request failed: ${response.status} ${await response.text()}`) as Error & { status: number; retryAfterHeader?: string };
      err.status = response.status;
      err.retryAfterHeader = response.headers.get("retry-after") ?? undefined;
      throw err;
    }
    return response.json() as Promise<T>;
  }
}
