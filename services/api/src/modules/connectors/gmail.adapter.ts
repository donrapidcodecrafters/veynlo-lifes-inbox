import { Inject, Injectable, Logger } from "@nestjs/common";
import { google, type gmail_v1 } from "googleapis";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";
import { extractGmailAttachmentMeta, type EmailAttachmentInput } from "../ingestion/gmail-message-parser";
import { completeBackfillRun, failBackfillRun, findOrCreateBackfillRun, recordBackfillPageProgress } from "./sync-run.util";

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];

// MAIL-004 "Attachment intelligence" — bounds how much an initial/incremental sync will fetch per
// attachment before handing it to DocumentsService.upload, which has its own, slightly larger 25MB cap
// (documents.service.ts's MAX_UPLOAD_BYTES) — checked here first purely to avoid pulling a huge base64
// blob across the Gmail API at all for something that would just be rejected on upload anyway.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * Direct-API connector for Gmail (§12.1, feasibility class A). Every method
 * here is real, working Gmail API integration — the only thing gated on
 * environment configuration is whether Google has issued OAuth credentials
 * for this deployment. Until `GOOGLE_OAUTH_CLIENT_ID/SECRET` are set,
 * `authorize()` throws a typed "connector not configured" error rather than
 * pretending to work.
 */
@Injectable()
export class GmailAdapter implements OAuthConnectorAdapter {
  private readonly logger = new Logger(GmailAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
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
    // ONB-002 — the historical-depth choice made on the onboarding (or Connections page) UI before this
    // OAuth round trip started, carried through the signed `state` param (see connectors.controller.ts's
    // signConnectState). Omitted entirely outside onboarding, in which case this behaves exactly as
    // before: the plan's full allowance.
    requestedHistoryDepthDays?: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) {
      throw new ConnectorNotConfiguredError("gmail");
    }
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId, params.requestedHistoryDepthDays);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "gmail",
      feasibilityClass: "direct_api",
      scopes: GMAIL_SCOPES,
      enabledCategories: ["purchases", "deliveries", "bills", "subscriptions", "appointments", "documents"],
      health: "initializing",
      historyDepthDays,
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

    // §42.5 "chunked, resumable... user-visible progress" — resumes a prior interrupted attempt (a BullMQ
    // retry after a crash/process restart mid-backfill) from its last completed page's checkpoint instead
    // of restarting from page 1. See sync-run.util.ts's own doc comment for the full rationale.
    const run = await findOrCreateBackfillRun(this.db, connectionId);
    let itemCount = run.itemsProcessed;
    let pageToken: string | undefined = run.checkpoint;

    try {
      do {
        const list = await gmail.users.messages.list({ userId: "me", q: query, pageToken, maxResults: 50 });
        for (const message of list.data.messages ?? []) {
          if (!message.id) continue;
          const full = await gmail.users.messages.get({ userId: "me", id: message.id, format: "full" });
          await this.ingestion.ingestGmailMessage({
            ownerUserId: connection.ownerUserId,
            householdId: connection.householdId,
            connectionId,
            message: full.data,
            attachments: await this.fetchAttachments(gmail, message.id, full.data),
            // §47.4 — this whole method is the historical-backfill sync (queued as `kind: "initial"` from
            // handleCallback above); incrementalSync below never sets this.
            isBackfill: true,
          });
          itemCount += 1;
        }
        pageToken = list.data.nextPageToken ?? undefined;

        // Persisted after EVERY page, not just at the end — the actual fix for §42.5's resumability
        // requirement (previously this only ever ran once, after the `do...while` loop finished entirely).
        await recordBackfillPageProgress(this.db, run, connectionId, itemCount, pageToken);
        run.pagesCompleted += 1;
      } while (pageToken);
    } catch (err) {
      await failBackfillRun(this.db, run.id, err);
      throw err;
    }

    // Gmail's history.list API (used by incrementalSync below) needs a starting point — the mailbox's
    // historyId as of right after this backfill, so nothing since is missed and nothing before is redone.
    const profile = await gmail.users.getProfile({ userId: "me" });

    await completeBackfillRun(this.db, run.id);
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
            await this.ingestion.ingestGmailMessage({
              ownerUserId: connection.ownerUserId,
              householdId: connection.householdId,
              connectionId,
              message: full.data,
              attachments: await this.fetchAttachments(gmail, messageId, full.data),
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

  /**
   * MAIL-004 "Attachment intelligence" — "Attachments inherit message provenance and are scanned before
   * OCR/extraction." Gmail's "full" format message already carries attachment METADATA (filename/mimeType/
   * a handle) inline, but the actual bytes need one `messages.attachments.get` call per part — done here,
   * right after the message itself is fetched, so both adapters (this one and OutlookAdapter) hand
   * IngestionService the same pre-fetched-bytes shape regardless of how differently each provider's API
   * exposes attachments. Best-effort per attachment: one broken/oversized attachment never fails the whole
   * message's ingestion — see the per-attachment try/catch below and IngestionService.processEmailAttachments'
   * own identical stance for the malware-scan/OCR/upload side of this same pipeline.
   */
  private async fetchAttachments(
    gmail: ReturnType<typeof google.gmail>,
    messageId: string,
    message: gmail_v1.Schema$Message,
  ): Promise<EmailAttachmentInput[]> {
    const meta = extractGmailAttachmentMeta(message);
    const attachments: EmailAttachmentInput[] = [];
    for (const part of meta) {
      if (part.sizeEstimate > MAX_ATTACHMENT_BYTES) continue;
      try {
        const att = await gmail.users.messages.attachments.get({ userId: "me", messageId, id: part.attachmentId });
        if (!att.data.data) continue;
        const buffer = Buffer.from(att.data.data, "base64url");
        if (buffer.length > MAX_ATTACHMENT_BYTES) continue;
        attachments.push({ filename: part.filename, mimeType: part.mimeType, buffer });
      } catch (err) {
        this.logger.warn(`Failed to fetch Gmail attachment ${part.attachmentId} on message ${messageId}: ${String(err)}`);
      }
    }
    return attachments;
  }
}

export { ConnectorNotConfiguredError };
