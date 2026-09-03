import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { google, type drive_v3 } from "googleapis";
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

const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

/** Same as `DocumentsService`'s own upload allowlist minus `text/plain` — Drive rarely holds raw .txt
 * receipts, and the OCR pipeline's value is on scanned PDFs/images anyway. */
const RELEVANT_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic"]);
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024; // matches DocumentsService.upload's own cap — no point downloading what it will reject

/**
 * Phase 2 §52.2 "cloud files" connector. Unlike Gmail/Calendar, a Drive file isn't a first-class domain
 * object with its own extraction schema — once downloaded it just IS a document (a receipt PDF a user
 * saved to Drive is identical in shape to one they'd have uploaded by hand), so this adapter deliberately
 * routes everything through `DocumentsService.upload()` rather than building a parallel
 * classify/extract/store pipeline: reuses the exact same magic-byte validation, malware scan, storage
 * quota check, and OCR queueing every manually-uploaded document already gets.
 *
 * Reuses the same GOOGLE_OAUTH_CLIENT_ID/SECRET as Gmail/Google Calendar (one Google Cloud OAuth app can
 * request all three scopes) as a separate `provider: "google_drive"` connection, so a user can connect
 * Drive without also connecting Gmail.
 */
@Injectable()
export class GoogleDriveAdapter implements OAuthConnectorAdapter {
  private readonly logger = new Logger(GoogleDriveAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(DocumentsService) private readonly documents: DocumentsService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  private oauthClient(redirectUri: string) {
    const env = loadEnv();
    return new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  }

  isConfigured(): boolean {
    return isConnectorConfigured("google");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_drive");
    const client = this.oauthClient(params.redirectUri);
    return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: DRIVE_SCOPES, state: params.state });
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_drive");
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "google_drive",
      feasibilityClass: "direct_api",
      scopes: DRIVE_SCOPES,
      enabledCategories: ["documents"],
      health: "initializing",
      historyDepthDays,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope },
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  private async client(connectionId: string) {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    const oauth = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/google-drive/callback`);
    oauth.setCredentials(credentials);
    return { connection, drive: google.drive({ version: "v3", auth: oauth }) };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, drive } = await this.client(connectionId);
    const since = new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000).toISOString();
    const mimeQuery = [...RELEVANT_MIME_TYPES].map((m) => `mimeType='${m}'`).join(" or ");

    let itemCount = 0;
    let pageToken: string | undefined;
    do {
      const list = await drive.files.list({
        q: `trashed = false and (${mimeQuery}) and modifiedTime > '${since}'`,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime)",
        pageSize: 100,
        pageToken,
        spaces: "drive",
      });
      for (const file of list.data.files ?? []) {
        if (await this.downloadAndIngest(connection, drive, file)) itemCount += 1;
      }
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Establishes the cursor for future incremental syncs — Drive's Changes API needs a starting page
    // token captured explicitly, it isn't returned alongside a files.list call the way Gmail's historyId
    // or Calendar's syncToken are.
    const startToken = await drive.changes.getStartPageToken({});

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: startToken.data.startPageToken ?? null })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /**
   * Real incremental sync via Drive's Changes API — the direct equivalent of Gmail's historyId and
   * Calendar's syncToken. An expired/invalid page token surfaces as a 400 (Drive doesn't use 410 for
   * this, unlike Calendar), so the same "fall back to a full resync rather than failing the connector" is
   * triggered on that specific error shape too.
   */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, drive } = await this.client(connectionId);
    if (!connection.cursor) return this.initialSync(connectionId);

    let itemCount = 0;
    let pageToken: string | undefined = connection.cursor;
    let newStartPageToken: string | null | undefined;
    try {
      do {
        const listParams: drive_v3.Params$Resource$Changes$List = {
          pageToken,
          fields: "nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, size, modifiedTime))",
          pageSize: 100,
        };
        const list = await drive.changes.list(listParams);
        for (const change of list.data.changes ?? []) {
          if (change.removed || !change.file) continue;
          if (await this.downloadAndIngest(connection, drive, change.file)) itemCount += 1;
        }
        pageToken = list.data.nextPageToken ?? undefined;
        if (list.data.newStartPageToken) newStartPageToken = list.data.newStartPageToken;
      } while (pageToken);
    } catch (err) {
      const status = (err as { code?: number; response?: { status?: number } })?.code ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 400 || status === 404 || status === 410) return this.initialSync(connectionId);
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: newStartPageToken ?? connection.cursor,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async downloadAndIngest(
    connection: typeof schema.connections.$inferSelect,
    drive: drive_v3.Drive,
    file: drive_v3.Schema$File,
  ): Promise<boolean> {
    if (!file.id || !file.mimeType || !RELEVANT_MIME_TYPES.has(file.mimeType)) return false;
    const size = file.size ? Number(file.size) : 0;
    if (size > MAX_DOWNLOAD_BYTES) return false;

    try {
      const response = await drive.files.get({ fileId: file.id, alt: "media" }, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data as ArrayBuffer);
      if (buffer.length === 0 || buffer.length > MAX_DOWNLOAD_BYTES) return false;

      const contentHash = createHash("sha256").update(buffer).digest("hex");
      const alreadyImported = await this.documents.findByContentHash(connection.ownerUserId, contentHash);
      if (alreadyImported) return false;

      await this.documents.upload({
        ownerUserId: connection.ownerUserId,
        householdId: connection.householdId,
        title: file.name ?? "Untitled Drive file",
        documentType: "other",
        mimeType: file.mimeType,
        buffer,
      });
      return true;
    } catch (err) {
      this.logger.warn(`Failed to import Drive file ${file.id}: ${String(err)}`);
      return false;
    }
  }
}
