import { Inject, Injectable } from "@nestjs/common";
import { google, type tasks_v1 } from "googleapis";
import { eq } from "drizzle-orm";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { IngestionService } from "../ingestion/ingestion.service";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { ConnectorNotConfiguredError, classifyPermissionHealth, parseGrantedScopes } from "./connector-errors";
import { ConnectorsService } from "./connectors.service";

// Full read/write scope — Google Tasks has no narrower "events-only"-style scope to request.
const TASKS_SCOPES = ["https://www.googleapis.com/auth/tasks"];

/**
 * Direct-API connector for Google Tasks (§Connections task sync — previously only Apple Reminders worked).
 * Structurally like the calendar connectors, not Gmail: a Google Task already IS a task, so there's no
 * domain classification/AI extraction step — see `IngestionService.ingestFeedTask`, shared with Microsoft
 * To Do and Apple Reminders. Reuses the same GOOGLE_OAUTH_CLIENT_ID/SECRET as Gmail/Google Calendar (one
 * Google Cloud OAuth app can request all three scopes), just a separate `provider: "google_tasks"`
 * connection so a user can connect one without the others.
 *
 * TASK-002 "write-back capability" — `pushTask` closes what used to be a pull-only connector (like Apple
 * Reminders, which has no write-back API to speak of): an explicit, user-triggered push of a Veynlo task to
 * this connection's Google Tasks, same bounded scope as GoogleCalendarAdapter.pushEvent (one-way, on
 * explicit action, not continuous two-way sync).
 *
 * Google Tasks has no syncToken/delta mechanism like Calendar — incremental sync instead polls
 * `tasks.list` with `updatedMin` set to the previous sync's start time, the documented way to poll this
 * API for changes (`showDeleted`/`showHidden`/`showCompleted` all true so nothing is silently filtered out).
 */
@Injectable()
export class GoogleTasksAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly vault: CredentialVault,
    private readonly ingestion: IngestionService,
    private readonly queue: QueueProducerService,
    private readonly connectors: ConnectorsService,
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
    historyDepthDays: number;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_tasks");
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const { connectionId } = await this.connectors.upsertConnectionForConnect({
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "google_tasks",
      feasibilityClass: "direct_api",
      // What Google actually granted, not what was requested — see classifyPermissionHealth's comment.
      scopes: parseGrantedScopes(tokens.scope),
      enabledCategories: ["tasks"],
      historyDepthDays: params.historyDepthDays,
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
    return { connection, tasks: google.tasks({ version: "v1", auth: oauth }) };
  }

  /**
   * TASK-002 "write-back capability" — creates on first push (no `externalSyncId` yet) and updates in
   * place on every push after, same create-vs-update decision as GoogleCalendarAdapter.pushEvent, just
   * keyed off `tasks.externalSyncId` instead of a dedicated provider-id column (tasks has no separate
   * `connectionId`/provider-id pair the way calendar_events does — see schedule.service.ts).
   */
  async pushTask(
    connectionId: string,
    task: { externalSyncId: string | null; title: string; dueDate: string | null; notes: string | null; completed: boolean },
  ): Promise<{ providerTaskId: string }> {
    const { tasks } = await this.client(connectionId);
    const requestBody: tasks_v1.Schema$Task = {
      title: task.title,
      notes: task.notes ?? undefined,
      due: task.dueDate ?? undefined,
      status: task.completed ? "completed" : "needsAction",
    };
    if (task.externalSyncId) {
      const updated = await tasks.tasks.update({ tasklist: "@default", task: task.externalSyncId, requestBody });
      return { providerTaskId: updated.data.id! };
    }
    const created = await tasks.tasks.insert({ tasklist: "@default", requestBody });
    return { providerTaskId: created.data.id! };
  }

  private async ingestTask(connection: typeof schema.connections.$inferSelect, connectionId: string, task: tasks_v1.Schema$Task): Promise<boolean> {
    if (!task.id) return false;
    if (task.deleted) {
      await this.db
        .delete(schema.tasks)
        .where(eq(schema.tasks.externalSyncId, task.id));
      return false; // a removal isn't a new item to count/file — nothing to review
    }
    return this.ingestion.ingestFeedTask({
      provider: "google_tasks",
      ownerUserId: connection.ownerUserId,
      householdId: connection.householdId,
      connectionId,
      uid: task.id,
      title: task.title ?? "Untitled task",
      dueIso: task.due ?? null,
      notes: task.notes ?? null,
      completed: task.status === "completed",
    });
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, tasks } = await this.client(connectionId);
    const syncStartedAt = new Date().toISOString();

    let itemCount = 0;
    let pageToken: string | undefined;
    do {
      const list = await tasks.tasks.list({
        tasklist: "@default",
        showCompleted: true,
        showHidden: true,
        showDeleted: true,
        maxResults: 100,
        pageToken,
      });
      for (const task of list.data.items ?? []) {
        if (await this.ingestTask(connection, connectionId, task)) itemCount += 1;
      }
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, TASKS_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: itemCount,
        cursor: syncStartedAt,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /** Polls everything updated since the previous sync's start time (the closest this API has to a delta
   * query). No 410-style "cursor expired" failure mode exists for a plain timestamp filter, unlike
   * Calendar's syncToken/deltaLink — this can never go stale. */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, tasks } = await this.client(connectionId);
    if (!connection.cursor) return this.initialSync(connectionId);
    const syncStartedAt = new Date().toISOString();

    let itemCount = 0;
    let pageToken: string | undefined;
    do {
      const list = await tasks.tasks.list({
        tasklist: "@default",
        showCompleted: true,
        showHidden: true,
        showDeleted: true,
        updatedMin: connection.cursor,
        maxResults: 100,
        pageToken,
      });
      for (const task of list.data.items ?? []) {
        if (await this.ingestTask(connection, connectionId, task)) itemCount += 1;
      }
      pageToken = list.data.nextPageToken ?? undefined;
    } while (pageToken);

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, TASKS_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: syncStartedAt,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }
}

