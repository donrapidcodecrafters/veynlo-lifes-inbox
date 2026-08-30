import { Inject, Injectable } from "@nestjs/common";
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

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TASKS_SCOPES = ["offline_access", "Tasks.ReadWrite"];
const TASK_SELECT = "id,title,status,dueDateTime,body";

interface MicrosoftCredentials {
  access_token: string;
  refresh_token: string;
}

interface GraphTodoTaskList {
  id: string;
  wellknownListName?: string;
}

interface GraphTodoTask {
  id?: string;
  title?: string;
  status?: string;
  dueDateTime?: { dateTime?: string; timeZone?: string };
  body?: { content?: string };
  "@removed"?: { reason?: string };
}

/**
 * Direct-API connector for Microsoft To Do via Microsoft Graph (§Connections task sync — previously only
 * Apple Reminders worked). A separate connection from Outlook mail/calendar (own
 * `provider: "microsoft_todo"` row, same `MICROSOFT_OAUTH_CLIENT_ID/SECRET`). Structurally like the
 * calendar connectors, not OutlookAdapter: a Graph to-do task already IS a task, so there's no domain
 * classification/AI extraction step — see `IngestionService.ingestFeedTask`, shared with Google Tasks and
 * Apple Reminders. Uses Graph's `tasks/delta` on the user's default list, same shape as
 * MicrosoftCalendarAdapter's `calendarView/delta`.
 *
 * TASK-002 "write-back capability" — `pushTask` closes what used to be a pull-only connector: an explicit,
 * user-triggered push of a Veynlo task to this connection's Microsoft To Do, same bounded scope as
 * MicrosoftCalendarAdapter.pushEvent (one-way, on explicit action, not continuous two-way sync).
 */
@Injectable()
export class MicrosoftTodoAdapter {
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
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_todo");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", TASKS_SCOPES.join(" "));
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
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_todo");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const { connectionId } = await this.connectors.upsertConnectionForConnect({
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "microsoft_todo",
      feasibilityClass: "direct_api",
      // What Microsoft actually granted, not what was requested — see classifyPermissionHealth's comment.
      scopes: parseGrantedScopes(tokens.scope),
      enabledCategories: ["tasks"],
      historyDepthDays: params.historyDepthDays,
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

  private dueIso(due: GraphTodoTask["dueDateTime"]): string | null {
    if (!due?.dateTime) return null;
    return due.dateTime.endsWith("Z") ? due.dateTime : `${due.dateTime}Z`;
  }

  private async ingestTask(connection: typeof schema.connections.$inferSelect, connectionId: string, task: GraphTodoTask): Promise<boolean> {
    if (!task.id) return false;
    if (task["@removed"]) {
      await this.db.delete(schema.tasks).where(eq(schema.tasks.externalSyncId, task.id));
      return false; // a removal isn't a new item to count/file — nothing to review
    }
    return this.ingestion.ingestFeedTask({
      provider: "microsoft_todo",
      ownerUserId: connection.ownerUserId,
      householdId: connection.householdId,
      connectionId,
      uid: task.id,
      title: task.title ?? "Untitled task",
      dueIso: this.dueIso(task.dueDateTime),
      notes: task.body?.content || null,
      completed: task.status === "completed",
    });
  }

  /** The default list has no fixed/aliasable id like Google Tasks' "@default" — has to be looked up by
   * `wellknownListName === "defaultList"` once, at the start of a fresh sync (a resumed incremental sync's
   * stored deltaLink already encodes the list id, so this is only ever called from initialSync). */
  private async defaultListId(connection: typeof schema.connections.$inferSelect): Promise<string> {
    const page = await this.graphGet<{ value: GraphTodoTaskList[] }>(connection, `${GRAPH_BASE}/me/todo/lists`);
    const defaultList = page.value.find((l) => l.wellknownListName === "defaultList") ?? page.value[0];
    if (!defaultList) throw new Error("Microsoft To Do account has no task lists");
    return defaultList.id;
  }

  /**
   * TASK-002 "write-back capability" — creates on first push (no `externalSyncId` yet) and updates in
   * place on every push after, same create-vs-update decision as MicrosoftCalendarAdapter.pushEvent, keyed
   * off `tasks.externalSyncId` (this connector has no dedicated provider-id column — see
   * schedule.service.ts). Needs the default list id first since To Do (unlike Calendar) scopes tasks to a
   * list.
   */
  async pushTask(
    connectionId: string,
    task: { externalSyncId: string | null; title: string; dueDate: string | null; notes: string | null; completed: boolean },
  ): Promise<{ providerTaskId: string }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const listId = await this.defaultListId(connection);

    const body = {
      title: task.title,
      status: task.completed ? "completed" : "notStarted",
      dueDateTime: task.dueDate ? { dateTime: task.dueDate.replace("Z", ""), timeZone: "UTC" } : undefined,
      body: task.notes ? { content: task.notes, contentType: "text" } : undefined,
    };
    const result = task.externalSyncId
      ? await this.graphWrite<{ id: string }>(connection, `${GRAPH_BASE}/me/todo/lists/${listId}/tasks/${task.externalSyncId}`, "PATCH", body)
      : await this.graphWrite<{ id: string }>(connection, `${GRAPH_BASE}/me/todo/lists/${listId}/tasks`, "POST", body);
    return { providerTaskId: result.id };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const listId = await this.defaultListId(connection);
    let url = `${GRAPH_BASE}/me/todo/lists/${listId}/tasks/delta?$select=${TASK_SELECT}`;

    let itemCount = 0;
    let deltaLink: string | null = null;
    do {
      const page = await this.graphGet<{ value: GraphTodoTask[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
      for (const task of page.value) {
        if (await this.ingestTask(connection, connectionId, task)) itemCount += 1;
      }
      if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    } while (url);

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, TASKS_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: itemCount,
        cursor: deltaLink,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  /** Real incremental sync driven by the deltaLink `initialSync` established. A stale/expired deltaLink
   * (Graph returns 410 Gone) falls back to a fresh full resync, same recovery as MicrosoftCalendarAdapter. */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    if (!connection.cursor) return this.initialSync(connectionId);

    let itemCount = 0;
    let url = connection.cursor;
    let latestDeltaLink = connection.cursor;

    try {
      do {
        const page = await this.graphGet<{ value: GraphTodoTask[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
        for (const task of page.value) {
          if (await this.ingestTask(connection, connectionId, task)) itemCount += 1;
        }
        if (page["@odata.deltaLink"]) latestDeltaLink = page["@odata.deltaLink"];
        url = page["@odata.nextLink"] ?? "";
      } while (url);
    } catch (err) {
      if ((err as { status?: number }).status === 410) return this.initialSync(connectionId);
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: classifyPermissionHealth(connection.scopes, TASKS_SCOPES),
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: latestDeltaLink,
        retryNotBeforeAt: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: TASKS_SCOPES.join(" "),
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
      scope: TASKS_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date; scope?: string }> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw new Error(`Microsoft token request failed: ${response.status} ${await response.text()}`);
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "",
      expiresAt: new Date(Date.now() + json.expires_in * 1000),
      scope: json.scope,
    };
  }

  /** Same transparent-refresh-on-401 shape as MicrosoftCalendarAdapter.graphGet. */
  private async graphGet<T>(connection: { credentialRef: string | null }, url: string): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as MicrosoftCredentials;
    const headers = { authorization: `Bearer ${access_token}` };

    let response = await fetch(url, { headers });
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
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

  /** Same transparent-refresh-on-401 shape as graphGet, for POST/PATCH writes (task create/update). */
  private async graphWrite<T>(connection: { credentialRef: string | null }, url: string, method: "POST" | "PATCH", body: unknown): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as MicrosoftCredentials;
    const headers = { authorization: `Bearer ${access_token}`, "content-type": "application/json" };

    let response = await fetch(url, { method, headers, body: JSON.stringify(body) });
    if (response.status === 401) {
      const refreshed = await this.refreshAccessToken(refresh_token);
      await this.vault.rotate(connection.credentialRef, { access_token: refreshed.accessToken, refresh_token: refreshed.refreshToken }, refreshed.expiresAt);
      response = await fetch(url, { method, headers: { authorization: `Bearer ${refreshed.accessToken}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    }
    if (!response.ok) {
      const err = new Error(`Microsoft Graph write failed: ${response.status} ${await response.text()}`) as Error & { status: number; retryAfterHeader?: string };
      err.status = response.status;
      err.retryAfterHeader = response.headers.get("retry-after") ?? undefined;
      throw err;
    }
    return response.json() as Promise<T>;
  }
}

