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
      historyDepthDays: 90,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope },
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    // Kick off the initial backfill asynchronously; ingestion pipeline tracks its own progress/health.
    void this.initialSync(connectionId).catch(async (err) => {
      await this.db
        .update(schema.connections)
        .set({ health: "degraded", healthDetail: String(err?.message ?? err) })
        .where(eq(schema.connections.id, connectionId));
    });

    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const credentials = await this.vault.read(connection.credentialRef);
    const client = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/gmail/callback`);
    client.setCredentials(credentials as Record<string, unknown>);
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
        await this.ingestion.ingestGmailMessage({
          ownerUserId: connection.ownerUserId,
          householdId: connection.householdId,
          connectionId,
          message: full.data,
        });
        itemCount += 1;
      }
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }
}

export class ConnectorNotConfiguredError extends Error {
  constructor(public readonly provider: string) {
    super(`${provider} connector is not configured on this deployment (missing OAuth client credentials).`);
    this.name = "ConnectorNotConfiguredError";
  }
}
