import { Inject, Injectable } from "@nestjs/common";
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
import { oauthTokenRequestError } from "./connection-health.util";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TODO_SCOPES = ["offline_access", "Tasks.Read"];

interface MicrosoftToDoCredentials {
  access_token: string;
  refresh_token: string;
}

interface GraphTodoTask {
  id: string;
  title?: string;
  status?: string; // "notStarted" | "inProgress" | "completed" | ...
  dueDateTime?: { dateTime?: string } | null;
}

/** Per-list delta cursors, JSON-encoded into the single `connections.cursor` column — Microsoft's delta
 * query is scoped per todo-list, unlike OneDrive's single whole-drive delta, so one opaque string has to
 * carry a small map instead of one link. */
type TodoCursor = Record<string, string>; // listId -> deltaLink

/**
 * Phase 2 §52.2 "tasks/reminders integrations" for Microsoft To Do. Reuses the same
 * MICROSOFT_OAUTH_CLIENT_ID/SECRET as Outlook/Microsoft Calendar/OneDrive as a separate
 * `provider: "microsoft_todo"` connection, counted against the same `calendar_connections_max` quota as
 * every other scheduling connector.
 */
@Injectable()
export class MicrosoftToDoAdapter implements OAuthConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
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
    url.searchParams.set("scope", TODO_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: {
    code: string;
    redirectUri: string;
    ownerUserId: string;
    householdId: string | null;
  }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_todo");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "microsoft_todo",
      feasibilityClass: "direct_api",
      scopes: TODO_SCOPES,
      enabledCategories: ["tasks"],
      health: "initializing",
      historyDepthDays,
    });
    const credentialRef = await this.vault.store(connectionId, { access_token: tokens.accessToken, refresh_token: tokens.refreshToken }, tokens.expiresAt);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

    const lists = await this.graphGet<{ value: { id: string }[] }>(connection, `${GRAPH_BASE}/me/todo/lists`);
    let itemCount = 0;
    const cursor: TodoCursor = {};
    for (const list of lists.value) {
      const { count, deltaLink } = await this.walkList(connection, list.id, `${GRAPH_BASE}/me/todo/lists/${list.id}/tasks/delta`);
      itemCount += count;
      if (deltaLink) cursor[list.id] = deltaLink;
    }

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: JSON.stringify(cursor) })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    if (!connection.cursor) return this.initialSync(connectionId);

    let priorCursor: TodoCursor;
    try {
      priorCursor = JSON.parse(connection.cursor) as TodoCursor;
    } catch {
      return this.initialSync(connectionId);
    }

    let itemCount = 0;
    const nextCursor: TodoCursor = { ...priorCursor };
    try {
      for (const [listId, deltaLink] of Object.entries(priorCursor)) {
        const { count, deltaLink: newDeltaLink } = await this.walkList(connection, listId, deltaLink);
        itemCount += count;
        if (newDeltaLink) nextCursor[listId] = newDeltaLink;
      }
    } catch (err) {
      if ((err as { status?: number }).status === 410) return this.initialSync(connectionId);
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: JSON.stringify(nextCursor),
      })
      .where(eq(schema.connections.id, connectionId));

    return { itemCount };
  }

  private async walkList(
    connection: typeof schema.connections.$inferSelect,
    listId: string,
    startUrl: string,
  ): Promise<{ count: number; deltaLink: string | null }> {
    let count = 0;
    let url = startUrl;
    let deltaLink: string | null = null;
    do {
      const page = await this.graphGet<{ value: GraphTodoTask[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
      for (const task of page.value) {
        if (await this.importTask(connection, listId, task)) count += 1;
      }
      if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
      url = page["@odata.nextLink"] ?? "";
    } while (url);
    return { count, deltaLink };
  }

  private async importTask(connection: typeof schema.connections.$inferSelect, listId: string, task: GraphTodoTask): Promise<boolean> {
    if (!task.id) return false;
    const { created } = await this.schedule.upsertExternalTask({
      ownerUserId: connection.ownerUserId,
      householdId: connection.householdId,
      provider: "microsoft_todo",
      externalId: `${listId}:${task.id}`,
      title: task.title ?? "Untitled task",
      dueDate: task.dueDateTime?.dateTime ? task.dueDateTime.dateTime.slice(0, 10) : null,
      completed: task.status === "completed",
    });
    return created;
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: TODO_SCOPES.join(" "),
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
      scope: TODO_SCOPES.join(" "),
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
    const { access_token, refresh_token } = credentials as unknown as MicrosoftToDoCredentials;

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
