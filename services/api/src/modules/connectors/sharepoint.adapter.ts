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

/**
 * `Sites.Read.All` reads site metadata AND the document libraries inside them, so no separate
 * `Files.Read.All` is needed — and asking for one anyway would widen the consent screen for nothing.
 */
const SHAREPOINT_SCOPES = ["offline_access", "Sites.Read.All"];

const RELEVANT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic"]);
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Ceilings. A corporate tenant can have thousands of sites and libraries; a household app has no business
 * walking all of them, and an unbounded first sync against a large tenant is a way to get rate-limited
 * into a degraded connection on day one.
 */
const MAX_SITES = 25;
const MAX_DRIVES_PER_SITE = 5;

interface SharePointCredentials {
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

interface GraphSite {
  id?: string;
  displayName?: string;
  name?: string;
}

interface GraphDrive {
  id?: string;
  name?: string;
}

/**
 * One delta link per document library, because a SharePoint connection is many drives rather than one.
 *
 * OneDrive stores a single `@odata.deltaLink` string in `connections.cursor`. SharePoint cannot: each
 * library has its own delta stream, and collapsing them would mean re-walking every library from scratch
 * whenever any one of them advanced. So the cursor holds a map, serialised into the same encrypted column.
 */
type DriveCursors = Record<string, string>;

/**
 * SharePoint — the Appendix A "SharePoint user-authorized sources" row.
 *
 * Runs on the same Microsoft Graph and the SAME registered application as Outlook, Microsoft Calendar,
 * Microsoft To Do and OneDrive (`MICROSOFT_OAUTH_CLIENT_ID`/`SECRET`), so this deployment needs no new
 * credential of any kind — it becomes available the moment Microsoft OAuth is configured at all. Only the
 * scope and the drive discovery differ from OneDrive; the delta walk, the download and the document
 * filing are the same shape, deliberately, because they are the same problem.
 *
 * ---------------------------------------------------------------------------------------------------
 * Which sites are read, and why not all of them
 * ---------------------------------------------------------------------------------------------------
 * `Sites.Read.All` can read every site the signed-in user can reach. In a real tenant that is routinely
 * hundreds of sites and many gigabytes belonging to their employer, almost none of it anything to do with
 * running a household. Syncing all of it would be a privacy problem wearing a feature's clothes, and the
 * spec row says "user-authorized sources" rather than "all sources".
 *
 * So this reads the sites the user FOLLOWS (`/me/followedSites`) and nothing else. Following a site in
 * SharePoint is already the user saying "this one matters to me" — an authorization they have expressed
 * in the product that owns the data, rather than a second list this app asks them to maintain. A site
 * followed later is picked up on the next sync; a site unfollowed stops being read.
 *
 * What that means in practice, stated plainly because it is a real limitation: a document in a site the
 * user has access to but has not followed will NOT be imported. That is the intended behaviour, and the
 * UI says so rather than leaving someone to wonder why a file never appeared.
 */
@Injectable()
export class SharePointAdapter implements OAuthConnectorAdapter {
  private readonly logger = new Logger(SharePointAdapter.name);

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
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("sharepoint");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", SHAREPOINT_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("sharepoint");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "sharepoint",
      feasibilityClass: "direct_api",
      scopes: SHAREPOINT_SCOPES,
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
    return this.sync(connectionId, true);
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId, false);
  }

  private async sync(connectionId: string, initial: boolean): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const cursors = parseDriveCursors(connection.cursor);
    const since = initial ? Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000 : null;

    const drives = await this.discoverDrives(connection);
    let itemCount = 0;
    const nextCursors: DriveCursors = {};

    for (const drive of drives) {
      const startUrl = !initial && cursors[drive.id] ? cursors[drive.id]! : `${GRAPH_BASE}/drives/${encodeURIComponent(drive.id)}/root/delta`;
      // A library whose cursor has no entry yet is new to this connection — someone followed a site since
      // the last sync — so it gets the history window rather than nothing, otherwise its existing
      // documents would never be imported at all.
      const driveSince = !initial && cursors[drive.id] ? null : since ?? Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000;

      try {
        const result = await this.walkDelta(connection, startUrl, driveSince);
        itemCount += result.itemCount;
        if (result.deltaLink) nextCursors[drive.id] = result.deltaLink;
        else if (cursors[drive.id]) nextCursors[drive.id] = cursors[drive.id]!;
      } catch (err) {
        if ((err as { status?: number }).status === 410) {
          // An expired delta token for ONE library. Re-walk that library from scratch; the others keep
          // their cursors, which is the point of storing them separately.
          const result = await this.walkDelta(connection, `${GRAPH_BASE}/drives/${encodeURIComponent(drive.id)}/root/delta`, null);
          itemCount += result.itemCount;
          if (result.deltaLink) nextCursors[drive.id] = result.deltaLink;
          continue;
        }
        // One library the user can see but Graph will not serve — a retention hold, a broken permission
        // inheritance — must not lose the other twenty-four. The connection stays healthy; this is a
        // normal state in a real tenant, not a broken connection.
        this.logger.warn(`SharePoint: skipping one library (${drive.siteName}): ${(err as Error)?.name ?? "error"}`);
        if (cursors[drive.id]) nextCursors[drive.id] = cursors[drive.id]!;
      }
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        healthDetail: null,
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: initial ? itemCount : (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: JSON.stringify(nextCursors),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /** The document libraries of every site the user follows — see this class's own doc comment for why followed. */
  private async discoverDrives(
    connection: typeof schema.connections.$inferSelect,
  ): Promise<Array<{ id: string; siteName: string }>> {
    const sites = await this.graphGet<{ value?: GraphSite[] }>(connection, `${GRAPH_BASE}/me/followedSites`);
    const out: Array<{ id: string; siteName: string }> = [];

    for (const site of (sites.value ?? []).slice(0, MAX_SITES)) {
      if (!site.id) continue;
      const siteName = site.displayName ?? site.name ?? "SharePoint site";
      try {
        const drives = await this.graphGet<{ value?: GraphDrive[] }>(connection, `${GRAPH_BASE}/sites/${encodeURIComponent(site.id)}/drives`);
        for (const drive of (drives.value ?? []).slice(0, MAX_DRIVES_PER_SITE)) {
          if (drive.id) out.push({ id: drive.id, siteName });
        }
      } catch (err) {
        this.logger.warn(`SharePoint: could not list libraries for one site: ${(err as Error)?.name ?? "error"}`);
      }
    }
    return out;
  }

  /**
   * Walks every page of a delta query, ingesting eligible files, and returns the final `@odata.deltaLink`
   * to persist as that library's next cursor. Identical in shape to OneDriveAdapter.walkDelta — the delta
   * endpoint has no server-side date filter, so the history window is applied per item here.
   */
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
      for (const item of page.value ?? []) {
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
      // The pre-authenticated `@microsoft.graph.downloadUrl` needs no bearer token of its own — that is
      // its entire purpose (a short-lived anonymous content URL Graph returns alongside metadata).
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
        title: item.name ?? "Untitled SharePoint file",
        documentType: "other",
        mimeType,
        buffer,
      });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to import SharePoint file ${item.id}: ${String(err)}`);
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
      scope: SHAREPOINT_SCOPES.join(" "),
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
      scope: SHAREPOINT_SCOPES.join(" "),
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
    const { access_token, refresh_token } = credentials as unknown as SharePointCredentials;

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

/**
 * Read the per-library cursor map back out of `connections.cursor`.
 *
 * Tolerant on purpose. The column is shared with every other connector, and a OneDrive-shaped bare delta
 * link — or anything else that is not this map — must degrade to "no cursors, walk from the start" rather
 * than throwing and leaving the connection permanently unable to sync. Losing a cursor costs one extra
 * full walk; throwing costs every future sync.
 */
export function parseDriveCursors(raw: string | null): DriveCursors {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: DriveCursors = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // Guards against a crafted or corrupted payload walking the prototype chain into the cursor map.
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (typeof value === "string" && value.length > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}
