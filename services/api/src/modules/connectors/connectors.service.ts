import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QueueProducerService } from "../../queue/queue-producer.service";
import { CredentialVault } from "../../common/credential-vault";

// Google's OAuth revocation endpoint accepts either an access or refresh token and invalidates the whole
// grant (all tokens issued under it) — a real, documented, single-call API. Microsoft's identity platform
// has no equivalent app-callable "revoke this refresh token" endpoint (revoking a specific app's consent is
// a user/admin action taken at account.live.com or the AAD admin center, not something this app can do via
// API on the user's behalf), so Microsoft-family providers only get the local credential deletion below —
// still the essential half of the fix, since that's the secret this app actually controls.
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_FAMILY_PROVIDERS = new Set(["gmail", "google_calendar", "google_tasks"]);

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly queueProducer: QueueProducerService,
    private readonly vault: CredentialVault,
  ) {}

  async listForUser(userId: string) {
    return this.db.select().from(schema.connections).where(eq(schema.connections.ownerUserId, userId));
  }

  /** §46 entitlement enforcement — counts only currently-active connections (a disconnected one shouldn't
   * count against the cap it's no longer consuming). */
  async countActiveConnections(userId: string, providers: string[]): Promise<number> {
    const rows = await this.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(and(eq(schema.connections.ownerUserId, userId), isNull(schema.connections.disconnectedAt), inArray(schema.connections.provider, providers)));
    return rows.length;
  }

  async getOwned(connectionId: string, userId: string) {
    const [connection] = await this.db
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.id, connectionId), eq(schema.connections.ownerUserId, userId)))
      .limit(1);
    if (!connection) throw new NotFoundException({ code: "CONNECTION_NOT_FOUND", message: "Connection not found." });
    return connection;
  }

  async disconnect(connectionId: string, userId: string, deleteDerivedData: boolean) {
    const connection = await this.getOwned(connectionId, userId);

    // §43.2/§45.1 — a disconnect must actually revoke access, not just stop this app from using it. Real,
    // previously-missing gap: neither the provider-side grant nor our own stored token was ever touched by
    // disconnect, so a user who "disconnected" still had a live, valid OAuth grant at the provider AND a
    // still-decryptable refresh token sitting in the database indefinitely.
    if (connection.credentialRef) {
      if (GOOGLE_FAMILY_PROVIDERS.has(connection.provider)) {
        try {
          const credentials = await this.vault.read(connection.credentialRef);
          const token = (credentials?.refresh_token ?? credentials?.access_token) as string | undefined;
          if (token) {
            await fetch(`${GOOGLE_REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: "POST" });
          }
        } catch (err) {
          // Best-effort — the token may already be invalid/expired at Google's end, and network errors
          // here must never block the user's own local disconnect. Local credential deletion below is the
          // guarantee this app actually controls; provider-side revocation is a bonus on top of it.
          this.logger.warn(`Provider-side revoke failed for connection ${connectionId} (continuing with local disconnect): ${err}`);
        }
      }
      await this.vault.delete(connection.credentialRef);
    }

    await this.db
      .update(schema.connections)
      .set({ health: "disconnected", disconnectedAt: new Date(), credentialRef: null })
      .where(eq(schema.connections.id, connectionId));
    // PRIV-002 — the actual deletion runs as a durable, resumable background job (worker-main.ts's
    // connectionDataDeletionWorker), same split as account deletion: this call only needs to enqueue it,
    // not block the request on however much data this connection produced.
    if (deleteDerivedData) {
      await this.queueProducer.enqueueConnectionDataDeletion({ connectionId, ownerUserId: userId });
    }
  }

  /**
   * §43.2 reauthorize() — previously every adapter's OAuth callback unconditionally inserted a brand-new
   * connections row, so reconnecting after e.g. reauth_required left the old stuck row orphaned forever
   * (never cleaned up, never merged) while creating a duplicate — silently consuming the user's
   * connector-count entitlement quota with rows they'd have no reason to know still existed. Now repairs
   * the existing, still-active (non-disconnected) connection of the same owner+provider in place instead of
   * creating a second one; only a genuinely new connect (no such row, or the old one was fully disconnected
   * first) creates a fresh row. The caller still stores the new credential and sets credentialRef itself
   * afterward — this only owns the connections row.
   */
  async upsertConnectionForConnect(params: {
    ownerUserId: string;
    householdId: string | null;
    provider: string;
    feasibilityClass: string;
    scopes: string[];
    enabledCategories: string[];
    historyDepthDays?: number | null;
  }): Promise<{ connectionId: string; isReconnect: boolean }> {
    const [existing] = await this.db
      .select({ id: schema.connections.id, credentialRef: schema.connections.credentialRef })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.ownerUserId, params.ownerUserId),
          eq(schema.connections.provider, params.provider),
          isNull(schema.connections.disconnectedAt),
        ),
      )
      .limit(1);

    if (existing) {
      if (existing.credentialRef) await this.vault.delete(existing.credentialRef); // about to be replaced by the caller
      await this.db
        .update(schema.connections)
        .set({
          householdId: params.householdId,
          scopes: params.scopes,
          enabledCategories: params.enabledCategories,
          health: "initializing",
          healthDetail: null,
          historyDepthDays: params.historyDepthDays ?? null,
          credentialRef: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.connections.id, existing.id));
      return { connectionId: existing.id, isReconnect: true };
    }

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: params.provider,
      feasibilityClass: params.feasibilityClass,
      scopes: params.scopes,
      enabledCategories: params.enabledCategories,
      health: "initializing",
      historyDepthDays: params.historyDepthDays ?? null,
    });
    return { connectionId, isReconnect: false };
  }

  async assertOwnership(connectionId: string, userId: string) {
    const connection = await this.getOwned(connectionId, userId);
    if (connection.ownerUserId !== userId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You do not own this connection." });
    }
    return connection;
  }
}
