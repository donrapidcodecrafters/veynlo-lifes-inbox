import { Inject, Injectable } from "@nestjs/common";
import { google } from "googleapis";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { ConnectorNotConfiguredError } from "./connector-errors";
import { extractGmailAttachmentRefs } from "../ingestion/gmail-message-parser";
import type { gmail_v1 } from "googleapis";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

/**
 * Direct-API connector for Gmail (§12.1, feasibility class A). Every method
 * here is real, working Gmail API integration — the only thing gated on
 * environment configuration is whether Google has issued OAuth credentials
 * for this deployment. Until `GOOGLE_OAUTH_CLIENT_ID/SECRET` are set,
 * `authorize()` throws a typed "connector not configured" error rather than
 * pretending to work.
 */
@Injectable()
export class GmailAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly ingestion: IngestionService,
    private readonly queue: QueueProducerService,
  ) {}

  private oauthClient(redirectUri: string) {
    const env = loadEnv();
    return new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  }

  isConfigured(): boolean {
    return isConnectorConfigured("google");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) {
      throw new ConnectorNotConfiguredError("gmail");
    }
    const client = this.oauthClient(params.redirectUri);
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      scope: GMAIL_SCOPES,
      state: params.state,
    });
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
    historyDepthDays: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) {
      throw new ConnectorNotConfiguredError("gmail");
    }
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "gmail",
      feasibilityClass: "direct_api",
      scopes: GMAIL_SCOPES,
      enabledCategories: ["purchases", "deliveries", "bills", "subscriptions", "appointments", "documents"],
      health: "initializing",
      historyDepthDays: params.historyDepthDays,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope },
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    // The initial backfill runs as a durable background job (services/api/src/worker-main.ts), not inline
    // on this request — a large mailbox or a process restart mid-sync must not lose progress or leave the
    // OAuth callback hanging (§42.5 "historical backfill: chunked, resumable, rate-limited").
    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });

    return { connectionId };
  }

  /**
   * MAIL-004 "attachment intelligence" — Gmail's `messages.get(format:"full")` response only carries
   * attachment metadata (filename/mimeType/attachmentId), never the bytes; a separate
   * `messages.attachments.get` call per attachment is required to actually fetch content, base64url-
   * encoded the same way inline part bodies are. Best-effort: one failed attachment fetch (a since-deleted
   * attachment, a transient API error) logs and skips rather than failing the whole message's ingestion.
   */
  private async downloadAttachments(gmail: ReturnType<typeof google.gmail>, messageId: string, message: gmail_v1.Schema$Message) {
    const refs = extractGmailAttachmentRefs(message.payload ?? undefined);
    const attachments: Array<{ filename: string; mimeType: string; buffer: Buffer }> = [];
    for (const ref of refs) {
      try {
        const attachment = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: ref.attachmentId });
        if (!attachment.data.data) continue;
        attachments.push({ filename: ref.filename, mimeType: ref.mimeType, buffer: Buffer.from(attachment.data.data, "base64url") });
      } catch {
        // Best-effort — see doc comment above.
      }
    }
    return attachments;
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    const client = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/gmail/callback`);
    client.setCredentials(credentials);
    const gmail = google.gmail({ version: "v1", auth: client });

    const afterDate = new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000);
    const query = `after:${Math.floor(afterDate.getTime() / 1000)}`;

    let itemCount = 0;
    let pageToken: string | undefined;
    do {
      const list = await gmail.users.messages.list({ userId: "me", q: query, pageToken, maxResults: 50 });
      for (const message of list.data.messages ?? []) {
        if (!message.id) continue;
        const full = await gmail.users.messages.get({ userId: "me", id: message.id, format: "full" });
        const attachments = await this.downloadAttachments(gmail, message.id, full.data);
        await this.ingestion.ingestGmailMessage({
          ownerUserId: connection.ownerUserId,
          householdId: connection.householdId,
          connectionId,
          message: full.data,
          attachments,
        });
        itemCount += 1;
      }
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);

    // Gmail's history.list API (used by incrementalSync below) needs a starting point — the mailbox's
    // historyId as of right after this backfill, so nothing since is missed and nothing before is redone.
    const profile = await gmail.users.getProfile({ userId: "me" });

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: itemCount,
        cursor: profile.data.historyId ?? null,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /**
   * Real incremental sync (§ROADMAP "Gmail incremental/recurring sync"),
   * driven by `history.list` keyed off the `connections.cursor` historyId
   * captured at the end of `initialSync`. Gmail expires history records
   * after some time — if `startHistoryId` is too old, `history.list` 404s,
   * in which case this falls back to a fresh full backfill (which also
   * re-establishes a current cursor) rather than silently going quiet.
   */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    if (!connection.cursor) {
      return this.initialSync(connectionId);
    }

    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    const client = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/gmail/callback`);
    client.setCredentials(credentials);
    const gmail = google.gmail({ version: "v1", auth: client });

    let itemCount = 0;
    let pageToken: string | undefined;
    let latestHistoryId = connection.cursor;

    try {
      do {
        const list = await gmail.users.history.list({
          userId: "me",
          startHistoryId: connection.cursor,
          historyTypes: ["messageAdded"],
          pageToken,
          maxResults: 100,
        });

        const seenMessageIds = new Set<string>();
        for (const record of list.data.history ?? []) {
          for (const added of record.messagesAdded ?? []) {
            const messageId = added.message?.id;
            if (!messageId || seenMessageIds.has(messageId)) continue;
            seenMessageIds.add(messageId);
            const full = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
            const attachments = await this.downloadAttachments(gmail, messageId, full.data);
            await this.ingestion.ingestGmailMessage({
              ownerUserId: connection.ownerUserId,
              householdId: connection.householdId,
              connectionId,
              message: full.data,
              attachments,
            });
            itemCount += 1;
          }
        }

        if (list.data.historyId) latestHistoryId = list.data.historyId;
        pageToken = list.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (err) {
      // history.list 404s once startHistoryId falls outside Gmail's retention window — the documented
      // recovery is a fresh full sync, not treating this as a fatal connector failure.
      const status = (err as { code?: number; response?: { status?: number } })?.code ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 404) {
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
        cursor: latestHistoryId,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }
}

export { ConnectorNotConfiguredError };
