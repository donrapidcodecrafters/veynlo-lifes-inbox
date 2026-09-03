import { Inject, Injectable } from "@nestjs/common";
import { google, type tasks_v1 } from "googleapis";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { ScheduleService } from "../schedule/schedule.service";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";

const TASKS_SCOPES = ["https://www.googleapis.com/auth/tasks.readonly"];

/**
 * Phase 2 §52.2 "tasks/reminders integrations" for Google Tasks. Reuses the same
 * GOOGLE_OAUTH_CLIENT_ID/SECRET as Gmail/Calendar/Drive as a separate `provider: "google_tasks"`
 * connection, counted against the same `calendar_connections_max` quota as the other scheduling
 * connectors (see EntitlementsService's CALENDAR_PROVIDERS) rather than inventing a new capability key
 * for what's conceptually the same kind of connection.
 *
 * The Tasks API v1 has no syncToken/deltaLink — `tasks.list`'s `updatedMin` filter is the closest thing to
 * an incremental query it offers, so the cursor here is just the ISO timestamp this sync started at,
 * reused as next time's `updatedMin`. Every matching task (across every tasklist) is upserted via
 * `ScheduleService.upsertExternalTask`, deduplicated by `(externalSyncProvider, externalSyncId)`.
 */
@Injectable()
export class GoogleTasksAdapter implements OAuthConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
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
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_tasks");
    const client = this.oauthClient(params.redirectUri);
    return client.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: TASKS_SCOPES, state: params.state });
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_tasks");
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "google_tasks",
      feasibilityClass: "direct_api",
      scopes: TASKS_SCOPES,
      enabledCategories: ["tasks"],
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
    const oauth = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/google-tasks/callback`);
    oauth.setCredentials(credentials);
    return { connection, tasksApi: google.tasks({ version: "v1", auth: oauth }) };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId, null);
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection) throw new Error(`Connection ${connectionId} not found`);
    return this.sync(connectionId, connection.cursor);
  }

  private async sync(connectionId: string, updatedMin: string | null): Promise<{ itemCount: number }> {
    const { connection, tasksApi } = await this.client(connectionId);
    const syncStartedAt = new Date().toISOString();
    const effectiveMin = updatedMin ?? new Date(Date.now() - (connection.historyDepthDays ?? 90) * 86_400_000).toISOString();

    const taskLists = await tasksApi.tasklists.list({ maxResults: 100 });
    let itemCount = 0;
    for (const list of taskLists.data.items ?? []) {
      if (!list.id) continue;
      let pageToken: string | undefined;
      do {
        const page = await tasksApi.tasks.list({
          tasklist: list.id,
          showCompleted: true,
          showHidden: true,
          updatedMin: effectiveMin,
          maxResults: 100,
          pageToken,
        });
        for (const task of page.data.items ?? []) {
          if (await this.importTask(connection, task)) itemCount += 1;
        }
        pageToken = page.data.nextPageToken ?? undefined;
      } while (pageToken);
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: syncStartedAt,
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async importTask(connection: typeof schema.connections.$inferSelect, task: tasks_v1.Schema$Task): Promise<boolean> {
    if (!task.id || task.deleted) return false;
    const { created } = await this.schedule.upsertExternalTask({
      ownerUserId: connection.ownerUserId,
      householdId: connection.householdId,
      provider: "google_tasks",
      externalId: task.id,
      title: task.title ?? "Untitled task",
      dueDate: task.due ? task.due.slice(0, 10) : null,
      completed: task.status === "completed",
    });
    return created;
  }
}
