import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CredentialVault } from "../../common/credential-vault";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { ScheduleService } from "../schedule/schedule.service";
import {
  findTokenTaskProvider,
  normalizeAsana,
  normalizeTodoist,
  normalizeTrello,
  type NormalizedTask,
  type TokenTaskProvider,
} from "./token-task-providers";
import type { ConnectorAdapter } from "./connector.interface";

/**
 * Todoist, Trello and Asana — three Appendix A task targets, connected with a token the user issues
 * themselves.
 *
 * One adapter rather than three, because the providers differ only in which URL to call and how to read
 * the answer. Everything that matters — verifying the credential before storing it, storing it encrypted,
 * bounding the sync, filing through `ScheduleService.upsertExternalTask` so these tasks are identical to
 * Google Tasks ones — is the same, and three copies of it would be three things to keep in step.
 *
 * No deployment credential is involved. These providers issue personal access tokens, so there is no app
 * to register and no client secret to hold, which is exactly why they are buildable here at all while
 * TickTick and Any.do (OAuth-only) are not.
 *
 * Tasks are filed by the provider's own id, never matched on title. Two tasks genuinely called "Renew
 * passport" in different apps are two tasks, and merging them on a string would silently lose one.
 */

/** One sync's ceiling. A Trello account with 5,000 cards must not become one unbounded import. */
const MAX_TASKS_PER_SYNC = 500;
const REQUEST_TIMEOUT_MS = 20_000;

interface TokenTaskCredentials {
  providerKey: string;
  token: string;
  /** Trello only. */
  apiKey?: string;
}

export interface TokenTaskConnectDto {
  providerKey: string;
  token: string;
  apiKey?: string;
}

@Injectable()
export class TokenTaskAdapter implements ConnectorAdapter {
  private readonly logger = new Logger(TokenTaskAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(ScheduleService) private readonly schedule: ScheduleService,
  ) {}

  /** Nothing to configure — the credential belongs to the user, not to this deployment. */
  isConfigured(): boolean {
    return true;
  }

  /**
   * Fetch this provider's tasks.
   *
   * Kept as one function with a switch rather than a method per provider: the differences are two lines
   * each, and splitting them would hide how similar they are while making the shared bounding and error
   * handling easy to skip in one of them.
   */
  private async fetchTasks(provider: TokenTaskProvider, creds: TokenTaskCredentials): Promise<NormalizedTask[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      if (provider.key === "todoist") {
        const response = await fetch(`${provider.apiBase}/rest/v2/tasks`, {
          headers: { authorization: `Bearer ${creds.token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`todoist responded ${response.status}`);
        return normalizeTodoist(await response.json());
      }

      if (provider.key === "trello") {
        // Trello authenticates by query parameter, which is why its key and token are both secrets and
        // both live in the vault. `filter=open` keeps archived cards out.
        const url = new URL(`${provider.apiBase}/1/members/me/cards`);
        url.searchParams.set("key", creds.apiKey ?? "");
        url.searchParams.set("token", creds.token);
        url.searchParams.set("filter", "open");
        url.searchParams.set("fields", "id,name,due,dueComplete,closed");
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`trello responded ${response.status}`);
        return normalizeTrello(await response.json());
      }

      if (provider.key === "asana") {
        // Asana requires a workspace, which is not something a user should have to look up and paste.
        // Discovered here instead, then used for the task query.
        const workspacesResponse = await fetch(`${provider.apiBase}/api/1.0/workspaces`, {
          headers: { authorization: `Bearer ${creds.token}` },
          signal: controller.signal,
        });
        if (!workspacesResponse.ok) throw new Error(`asana responded ${workspacesResponse.status}`);
        const workspaces = (await workspacesResponse.json()) as { data?: Array<{ gid?: string }> };
        const workspaceGid = workspaces.data?.[0]?.gid;
        if (!workspaceGid) return [];

        const url = new URL(`${provider.apiBase}/api/1.0/tasks`);
        url.searchParams.set("assignee", "me");
        url.searchParams.set("workspace", workspaceGid);
        url.searchParams.set("opt_fields", "gid,name,due_on,due_at,completed");
        url.searchParams.set("limit", "100");
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${creds.token}` },
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`asana responded ${response.status}`);
        return normalizeAsana(await response.json());
      }

      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Verify the token by using it, then store it.
   *
   * A token that is never exercised before being saved leaves a connection sitting in the user's list
   * looking healthy and producing nothing — the false "all caught up" state the spec forbids.
   */
  async connect(params: { dto: TokenTaskConnectDto; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    const provider = findTokenTaskProvider(params.dto.providerKey);
    if (!provider) {
      throw new BadRequestException({ code: "UNKNOWN_TASK_PROVIDER", message: "That task app isn't one we recognise." });
    }
    if (!params.dto.token?.trim()) {
      throw new BadRequestException({ code: "TASK_TOKEN_REQUIRED", message: `Enter your ${provider.label} token.` });
    }
    if (provider.requiresApiKey && !params.dto.apiKey?.trim()) {
      throw new BadRequestException({ code: "TASK_API_KEY_REQUIRED", message: `${provider.label} needs an API key as well as a token.` });
    }

    const credentials: TokenTaskCredentials = {
      providerKey: provider.key,
      token: params.dto.token.trim(),
      ...(provider.requiresApiKey ? { apiKey: params.dto.apiKey!.trim() } : {}),
    };

    try {
      await this.fetchTasks(provider, credentials);
    } catch (err) {
      // Never echo the provider's raw error — it can carry the token back in a URL.
      this.logger.warn(`${provider.key} connect failed: ${(err as Error)?.name ?? "error"}`);
      throw new BadRequestException({ code: "TASK_CONNECT_FAILED", message: provider.credentialHint });
    }

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: provider.key,
      feasibilityClass: "direct_api",
      scopes: ["tasks.read"],
      enabledCategories: ["tasks"],
      health: "initializing",
    });

    const credentialRef = await this.vault.store(connectionId, credentials as unknown as Record<string, unknown>, null);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId);
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId);
  }

  private async sync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const creds = (await this.vault.read(connection.credentialRef)) as TokenTaskCredentials | null;
    if (!creds) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);

    const provider = findTokenTaskProvider(creds.providerKey);
    if (!provider) throw new Error(`Connection ${connectionId} names an unknown task provider`);

    let itemCount = 0;
    try {
      const tasks = await this.fetchTasks(provider, creds);

      for (const task of tasks.slice(0, MAX_TASKS_PER_SYNC)) {
        // Filed exactly like a Google Tasks item, so a task from Todoist is not a second-class task.
        const { created } = await this.schedule.upsertExternalTask({
          ownerUserId: connection.ownerUserId,
          householdId: connection.householdId,
          provider: provider.key,
          externalId: task.externalId,
          title: task.title,
          dueDate: task.dueDate,
          completed: task.completed,
        });
        if (created) itemCount += 1;
      }

      await this.db
        .update(schema.connections)
        .set({
          health: "healthy",
          healthDetail: null,
          lastSuccessfulSyncAt: new Date(),
          itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        })
        .where(eq(schema.connections.id, connectionId));
    } catch (err) {
      // A revoked or rotated token is the spec's "reauthorization required" state, not a transient fault
      // to retry forever.
      const message = String((err as Error)?.message ?? "");
      const authFailed = /\b(401|403)\b/.test(message);
      await this.db
        .update(schema.connections)
        .set({
          health: authFailed ? "reauth_required" : "degraded",
          healthDetail: authFailed
            ? `${provider.label} rejected the saved token. Personal tokens are revoked when you change your password — generate a new one and reconnect.`
            : `Couldn't reach ${provider.label} on the last sync.`,
        })
        .where(eq(schema.connections.id, connectionId));
      throw err;
    }

    return { itemCount };
  }
}
