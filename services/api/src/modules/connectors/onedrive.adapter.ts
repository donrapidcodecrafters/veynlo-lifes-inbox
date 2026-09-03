import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { DocumentsService } from "../documents/documents.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";
import { oauthTokenRequestError } from "./connection-health.util";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const ONEDRIVE_SCOPES = ["offline_access", "Files.Read"];
const RELEVANT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic"]);
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

interface OneDriveCredentials {
  access_token: string;
  refresh_token: string;
}

interface DriveItem {
  id: string;
  name?: string;
  size?: number;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: unknown;
  deleted?: unknown;
  "@microsoft.graph.downloadUrl"?: string;
}

/**
 * Phase 2 §52.2 "cloud files" connector for OneDrive — reuses the exact same Microsoft OAuth app
 * (MICROSOFT_OAUTH_CLIENT_ID/SECRET) as `OutlookAdapter`/`MicrosoftCalendarAdapter`, just a separate
 * `provider: "onedrive"` connection with its own scope (`Files.Read` instead of `Mail.Read`). Unlike
 * Outlook's two-step "date-filtered backfill, then separately-fetched deltaLink", OneDrive's `delta`
 * endpoint does both in one query shape: the first call (no token) walks the whole drive tree page by
 * page and the final page carries `@odata.deltaLink`, so initial and incremental sync share one Graph
 * call pattern here — see `walkDelta`.
 */
@Injectable()
export class OneDriveAdapter implements OAuthConnectorAdapter {
  private readonly logger = new Logger(OneDriveAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("microsoft");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("onedrive");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", ONEDRIVE_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("onedrive");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "onedrive",
      feasibilityClass: "direct_api",
      scopes: ONEDRIVE_SCOPES,
      enabledCategories: ["documents"],
      health: "initializing",
      historyDepthDays,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.accessToken, refresh_token: tokens.refreshToken },
      tokens.expiresAt,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const since = Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000;
    const { itemCount, deltaLink } = await this.walkDelta(connection, `${GRAPH_BASE}/me/drive/root/delta`, since);

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: deltaLink })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /** A resyncRequired 410 (expired delta token) falls back to a full `initialSync`, same recovery shape
   * as every other adapter's cursor-expiry handling in this codebase. */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    if (!connection.cursor) return this.initialSync(connectionId);

    try {
      const { itemCount, deltaLink } = await this.walkDelta(connection, connection.cursor, null);
      await this.db
        .update(schema.connections)
        .set({
          health: "healthy",
          lastSuccessfulSyncAt: new Date(),
          itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
          cursor: deltaLink ?? connection.cursor,
        })
        .where(eq(schema.connections.id, connectionId));
      return { itemCount };
    } catch (err) {
      if ((err as { status?: number }).status === 410) return this.initialSync(connectionId);
      throw err;
    }
  }

  /** Walks every page of a delta query, ingesting eligible files along the way, and returns the final
   * `@odata.deltaLink` to persist as the next sync's cursor. `sinceMs` (only set on a fresh initial sync)
   * skips files last modified before the plan's historical-backfill window — the delta endpoint itself
   * has no server-side date filter, so this is applied client-side per item. */
  private async walkDelta(
    connection: typeof schema.connections.$inferSelect,
    startUrl: string,
    sinceMs: number | null,
  ): Promise<{ itemCount: number; deltaLink: string | null }> {
    let itemCount = 0;
    let url = startUrl;
    let deltaLink: string | null = null;
    do {
      const page = await this.graphGet<{ value: DriveItem[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
      for (const item of page.value) {
        if (item.deleted || item.folder || !item.file) continue;
        if (sinceMs !== null && item.lastModifiedDateTime && new Date(item.lastModifiedDateTime).getTime() < sinceMs) continue;
        if (await this.downloadAndIngest(connection, item)) itemCount += 1;
      }
      if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    } while (url);
    return { itemCount, deltaLink };
  }

  private async downloadAndIngest(connection: typeof schema.connections.$inferSelect, item: DriveItem): Promise<boolean> {
    const mimeType = item.file?.mimeType;
    if (!mimeType || !RELEVANT_MIME_TYPES.has(mimeType)) return false;
    if ((item.size ?? 0) > MAX_DOWNLOAD_BYTES) return false;
    const downloadUrl = item["@microsoft.graph.downloadUrl"];
    if (!downloadUrl) return false;

    try {
      // The pre-authenticated `@microsoft.graph.downloadUrl` needs no bearer token of its own — that's
      // its entire purpose (a short-lived, anonymous content URL Graph hands back alongside metadata).
      const response = await fetch(downloadUrl);
      if (!response.ok) return false;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return false;

      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const alreadyImported = await this.documents.findByContentHash(connection.ownerUserId, contentHash);
      if (alreadyImported) return false;

      await this.documents.upload({
        ownerUserId: connection.ownerUserId,
        householdId: connection.householdId,
        title: item.name ?? "Untitled OneDrive file",
        documentType: "other",
        mimeType,
        buffer,
      });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to import OneDrive file ${item.id}: ${String(err)}`);
      return false;
    }
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: ONEDRIVE_SCOPES.join(" "),
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
      scope: ONEDRIVE_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw oauthTokenRequestError("Microsoft", response.status, await response.text());
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  private async graphGet<T>(connection: { credentialRef: string | null }, url: string): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as OneDriveCredentials;

    let response = await fetch(url, { headers: { authorization: `Bearer ${access_token}` } });
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
      response = await fetch(url, { headers: { authorization: `Bearer ${refreshed.accessToken}` } });
    }
    if (!response.ok) {
      const err = new Error(`Microsoft Graph request failed: ${response.status} ${await response.text()}`) as Error & { status: number };
      err.status = response.status;
      throw err;
    }
    return response.json() as Promise<T>;
  }
}
