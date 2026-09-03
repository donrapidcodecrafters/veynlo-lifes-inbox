import { createHash } from "node:crypto";
import { extname } from "node:path";
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

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const API_BASE = "https://api.dropboxapi.com/2";
const CONTENT_BASE = "https://content.dropboxapi.com/2";
const DROPBOX_SCOPES = ["files.metadata.read", "files.content.read"];
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const EXTENSION_MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".heic": "image/heic",
};

interface DropboxCredentials {
  access_token: string;
  refresh_token: string;
}

interface DropboxEntry {
  ".tag": "file" | "folder" | "deleted";
  name: string;
  path_lower?: string;
  size?: number;
  server_modified?: string;
}

/**
 * Phase 2 §52.2 "cloud files" connector for Dropbox — unlike Google/Microsoft, Dropbox has no shared
 * OAuth app to reuse (it needs its own app registration in the Dropbox App Console, a real
 * "needs a live credential to fully test" boundary — see DROPBOX_CLIENT_ID/SECRET in config/env.ts). The
 * code path is fully built and follows the same "not configured" degradation as every other connector
 * so it activates the moment real credentials are supplied, needing no further code changes.
 *
 * Uses Dropbox's `list_folder`/`list_folder/continue` cursor pair (the direct equivalent of Gmail's
 * historyId, Calendar's syncToken, Drive's changes-page-token) — a cursor invalidated server-side comes
 * back as an HTTP 409 with an `error/.tag: "reset"` body, handled the same way every other adapter here
 * handles an expired cursor: fall back to a fresh full listing.
 */
@Injectable()
export class DropboxAdapter implements OAuthConnectorAdapter {
  private readonly logger = new Logger(DropboxAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("dropbox");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("dropbox");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.DROPBOX_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("token_access_type", "offline"); // requests a refresh_token, not just a short-lived access token
    url.searchParams.set("scope", DROPBOX_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("dropbox");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "dropbox",
      feasibilityClass: "direct_api",
      scopes: DROPBOX_SCOPES,
      enabledCategories: ["documents"],
      health: "initializing",
      historyDepthDays,
    });
    const credentialRef = await this.vault.store(connectionId, { access_token: tokens.accessToken, refresh_token: tokens.refreshToken }, tokens.expiresAt);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  /**
   * `list_folder` has no server-side "modified after X" filter, so the whole tree is walked on the first
   * sync (typical personal Dropboxes are small enough for this to be cheap; a very large business account
   * is exactly the case a direct-API feasibility class already assumes reasonable volume for, same as
   * Gmail's own full-mailbox history backfill) — `historyDepthDays` is applied client-side instead, via
   * each entry's own `server_modified` timestamp, so only files last touched within the plan's backfill
   * window actually get downloaded and imported.
   */
  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const since = Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000;
    const { itemCount, cursor } = await this.walk(connection, { path: "", recursive: true }, since);

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    if (!connection.cursor) return this.initialSync(connectionId);

    try {
      const { itemCount, cursor } = await this.walk(connection, { cursor: connection.cursor }, null);
      await this.db
        .update(schema.connections)
        .set({
          health: "healthy",
          lastSuccessfulSyncAt: new Date(),
          itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
          cursor: cursor ?? connection.cursor,
        })
        .where(eq(schema.connections.id, connectionId));
      return { itemCount };
    } catch (err) {
      if ((err as { status?: number }).status === 409) return this.initialSync(connectionId);
      throw err;
    }
  }

  private async walk(
    connection: typeof schema.connections.$inferSelect,
    start: { path: string; recursive: boolean } | { cursor: string },
    sinceMs: number | null,
  ): Promise<{ itemCount: number; cursor: string | null }> {
    let itemCount = 0;
    let cursor: string | null = null;
    let hasMore = true;
    let body: unknown = start;
    let url = "cursor" in start ? `${API_BASE}/files/list_folder/continue` : `${API_BASE}/files/list_folder`;

    while (hasMore) {
      const page = await this.apiPost<{ entries: DropboxEntry[]; cursor: string; has_more: boolean }>(connection, url, body);
      for (const entry of page.entries) {
        if (entry[".tag"] !== "file") continue;
        if (sinceMs !== null && entry.server_modified && new Date(entry.server_modified).getTime() < sinceMs) continue;
        if (await this.downloadAndIngest(connection, entry)) itemCount += 1;
      }
      cursor = page.cursor;
      hasMore = page.has_more;
      url = `${API_BASE}/files/list_folder/continue`;
      body = { cursor: page.cursor };
    }
    return { itemCount, cursor };
  }

  private async downloadAndIngest(connection: typeof schema.connections.$inferSelect, entry: DropboxEntry): Promise<boolean> {
    if (!entry.path_lower) return false;
    const mimeType = EXTENSION_MIME_TYPES[extname(entry.name).toLowerCase()];
    if (!mimeType) return false;
    if ((entry.size ?? 0) > MAX_DOWNLOAD_BYTES) return false;

    try {
      const buffer = await this.download(connection, entry.path_lower);
      if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return false;

      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const alreadyImported = await this.documents.findByContentHash(connection.ownerUserId, contentHash);
      if (alreadyImported) return false;

      await this.documents.upload({
        ownerUserId: connection.ownerUserId,
        householdId: connection.householdId,
        title: entry.name,
        documentType: "other",
        mimeType,
        buffer,
      });
      return true;
    } catch (err) {
      // §28 "No raw user emails/documents ... in normal application logs" — entry.path_lower is the
      // user's own Dropbox folder/file path (e.g. "/medical/jane doe results.pdf"), not an opaque ID like
      // every other connector adapter logs on the same failure path; log the connection instead.
      this.logger.warn(`Failed to import a Dropbox file for connection ${connection.id}: ${String(err)}`);
      return false;
    }
  }

  private async download(connection: { credentialRef: string | null }, pathLower: string): Promise<Buffer> {
    const accessToken = await this.accessToken(connection);
    const response = await fetch(`${CONTENT_BASE}/files/download`, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "Dropbox-API-Arg": JSON.stringify({ path: pathLower }) },
    });
    if (!response.ok) throw new Error(`Dropbox download failed: ${response.status} ${await response.text()}`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.DROPBOX_CLIENT_ID!,
      client_secret: env.DROPBOX_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    return this.requestToken(body);
  }

  private async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.DROPBOX_CLIENT_ID!,
      client_secret: env.DROPBOX_CLIENT_SECRET!,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw oauthTokenRequestError("Dropbox", response.status, await response.text());
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
    };
  }

  private async accessToken(connection: { credentialRef: string | null }): Promise<string> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    return (credentials as unknown as DropboxCredentials).access_token;
  }

  /** Dropbox's short-lived access tokens (a few hours) make a proactive-refresh-on-401 pattern
   * awkward to share across the many API calls a full-tree walk makes, so `apiPost` refreshes and
   * persists a new token transparently on 401, same posture as `OutlookAdapter.graphGet`. */
  private async apiPost<T>(connection: { credentialRef: string | null }, url: string, body: unknown): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as DropboxCredentials;

    const doPost = (token: string) =>
      fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    let response = await doPost(access_token);
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
      response = await doPost(refreshed.accessToken);
    }
    if (!response.ok) {
      const err = new Error(`Dropbox API request failed: ${response.status} ${await response.text()}`) as Error & { status: number };
      err.status = response.status;
      throw err;
    }
    return response.json() as Promise<T>;
  }
}
