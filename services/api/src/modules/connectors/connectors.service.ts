import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { IdentityService } from "../identity/identity.service";
import { CredentialVault } from "../../common/credential-vault";
import { normalizeSenderDomain } from "../intelligence/deterministic-prefilter";
import { PlaidAdapter } from "./plaid.adapter";
import { RETRIED_HEALTH_STATES } from "./connection-health.util";

/** The provider write scope ConnectorsService.setWriteBack checks for before enabling write-back — kept in
 * sync by hand with google-calendar.adapter.ts's `CALENDAR_WRITE_SCOPES`/microsoft-calendar.adapter.ts's
 * `CALENDAR_WRITE_SCOPES` (not imported directly, to avoid this service depending on either adapter just
 * for a string constant). */
const REQUIRED_WRITE_SCOPE: Record<string, string> = {
  google_calendar: "https://www.googleapis.com/auth/calendar",
  microsoft_calendar: "Calendars.ReadWrite",
};

/**
 * Provider-side token revocation (docs/INCIDENT_RESPONSE.md's "No provider-side token revocation call"
 * gap) — every Google-family connector shares one OAuth app (GOOGLE_OAUTH_CLIENT_ID/SECRET) and Google's
 * revoke endpoint takes any of that app's tokens with no client auth needed, so one endpoint covers all
 * four `provider` values here despite them being four separate `connections` rows / OAuth grants.
 */
const GOOGLE_REVOKE_PROVIDERS = new Set(["gmail", "google_calendar", "google_drive", "google_tasks", "google_contacts"]);
const DROPBOX_REVOKE_PROVIDERS = new Set(["dropbox"]);
/**
 * Microsoft's identity platform (v2 endpoint, what `outlook`/`microsoft_calendar`/`onedrive`/
 * `microsoft_todo` all authenticate through — see microsoft-*.adapter.ts) has NO application-callable
 * token-revocation API, unlike Google's `/revoke` or Dropbox's `/2/auth/token/revoke`. Microsoft's own
 * model puts revocation in the user's hands: they revoke an app's access from
 * https://myaccount.microsoft.com/, or a tenant admin revokes it from Azure AD/Entra — there is no
 * `POST https://login.microsoftonline.com/.../revoke`-style call this backend can make on the user's
 * behalf. (`/oauth2/v2.0/logout` exists but ends a *browser session*, not the token itself, and doesn't
 * apply to a server-held refresh token at all.) Documented here, deliberately not faked with a call that
 * would silently no-op or 404 — see docs/INCIDENT_RESPONSE.md §4's write-up of this same gap. The local
 * credential deletion below (unconditional, every provider) remains the real security boundary regardless.
 */
const MICROSOFT_NO_REVOKE_PROVIDERS = new Set(["outlook", "microsoft_calendar", "onedrive", "microsoft_todo", "microsoft_contacts"]);

/** Every provider the recurring incremental-scan tick (worker-main.ts's connectorScanWorker, via
 * ConnectorsService.listEligibleForIncrementalScan below) considers at all — kept here rather than
 * inlined in the worker so the eligibility query itself is unit-testable without a live BullMQ/Redis
 * worker process. */
const INCREMENTAL_SYNC_PROVIDERS = [
  "gmail",
  "outlook",
  "ics",
  "google_calendar",
  "microsoft_calendar",
  "google_drive",
  "onedrive",
  "dropbox",
  "google_tasks",
  "microsoft_todo",
  "plaid",
];

@Injectable()
export class ConnectorsService {
  private readonly logger = new Logger(ConnectorsService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(QUEUE_PRODUCER) private readonly queueProducer: QueueProducer,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(PlaidAdapter) private readonly plaid: PlaidAdapter,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
  ) {}

  async listForUser(userId: string) {
    // Stable order — without this, Postgres is free to return rows in whatever order its query plan
    // happens to produce, which visibly reshuffled the connection list in the UI after any mutation
    // (e.g. toggling write-back updates the row, and a subsequent list came back in a different order).
    // `createdAt` (connection order, oldest first) rather than `provider` — matches how a user thinks
    // about "the order I connected things," and ties are broken by `id` since `createdAt` isn't unique
    // enough on its own (rows created in the same seed/test batch can share a timestamp).
    return this.db
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.ownerUserId, userId))
      .orderBy(asc(schema.connections.createdAt), asc(schema.connections.id));
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

  async disconnect(connectionId: string, userId: string, deleteDerivedData: boolean, password: string | undefined) {
    const connection = await this.getOwned(connectionId, userId);
    // §28.9 step-up auth — only for the destructive variant. A plain "unlink but keep my data" disconnect
    // is routine and low-stakes; asking for a password on every one of those would just train users to
    // click through security prompts without reading them. deleteDerivedData is the actually irreversible
    // action worth re-verifying identity for.
    if (deleteDerivedData) {
      await this.identity.verifyStepUpPassword(userId, password);
    }
    // Plaid Items are a real recurring cost on Plaid's side — unlike an OAuth token that just expires
    // unused, a disconnected-but-never-revoked Item keeps counting against (and billing) the account.
    // Every disconnect revokes it, independent of whether the user also asked to delete derived data.
    // Must run before the credential row is deleted below — revoke() reads the still-live credential to
    // get Plaid's access_token.
    if (connection.provider === "plaid") {
      await this.plaid.revoke(connectionId);
    } else if (GOOGLE_REVOKE_PROVIDERS.has(connection.provider) || DROPBOX_REVOKE_PROVIDERS.has(connection.provider)) {
      await this.revokeProviderToken(connection);
    } else if (MICROSOFT_NO_REVOKE_PROVIDERS.has(connection.provider)) {
      // No-op, deliberately — see MICROSOFT_NO_REVOKE_PROVIDERS' own doc comment for why there's nothing
      // to call. Listed explicitly (rather than just falling through the else-if chain unlabeled) so this
      // reads as "considered and skipped," not "forgotten."
    }
    // §45.1 "OAuth/provider tokens live in a dedicated encrypted credential subsystem" — a disconnected
    // connection must not leave its token sitting around decryptable. Previously this method only flipped
    // `health` to "disconnected" and left the connection_credentials row (and, for Plaid, an already-
    // revoked-upstream-but-still-locally-decryptable access_token) untouched indefinitely — a stale token
    // in the vault is still a real exposure (key compromise, insider access, a future bug that reads it by
    // credentialRef) even though the provider itself would reject it. Deleted unconditionally, independent
    // of `deleteDerivedData` — the token isn't "derived data", it's the credential itself, and there's no
    // reason to keep it decryptable just because the user chose to keep their synced bills/events.
    await this.db.delete(schema.connectionCredentials).where(eq(schema.connectionCredentials.connectionId, connectionId));
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
   * Calls the OAuth provider's own token-revocation endpoint before this connection's credential row is
   * deleted below. Deliberately best-effort: logged and swallowed on failure, never thrown — the local
   * `connection_credentials` delete (this method's caller, unconditional for every provider) is the actual
   * security boundary (§45.1), same reasoning PlaidAdapter.revoke's own try/catch already documents for
   * Plaid. This is defense-in-depth on top of that, not load-bearing: a revoke call that fails (network
   * blip, provider outage, an already-expired token) must never block the user from disconnecting.
   */
  private async revokeProviderToken(connection: typeof schema.connections.$inferSelect): Promise<void> {
    if (!connection.credentialRef) return; // nothing to revoke — the credential row is already gone/never existed
    let accessToken: string | undefined;
    try {
      const credentials = await this.vault.read(connection.credentialRef);
      accessToken = (credentials as { access_token?: string } | null)?.access_token;
    } catch (err) {
      this.logger.warn(`Could not read credential to revoke ${connection.provider} token for connection ${connection.id}: ${String(err)}`);
      return;
    }
    if (!accessToken) return;

    try {
      if (GOOGLE_REVOKE_PROVIDERS.has(connection.provider)) {
        // https://developers.google.com/identity/protocols/oauth2/web-server#tokenrevoke — a bare form-
        // encoded POST, no client id/secret required to revoke a token you already hold.
        await fetch("https://oauth2.googleapis.com/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token: accessToken }),
        });
      } else if (DROPBOX_REVOKE_PROVIDERS.has(connection.provider)) {
        // https://www.dropbox.com/developers/documentation/http/documentation#auth-token-revoke — revokes
        // whichever token authenticates the request itself; no token in the body/params.
        await fetch("https://api.dropboxapi.com/2/auth/token/revoke", {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      }
    } catch (err) {
      this.logger.warn(`Failed to revoke ${connection.provider} token upstream for connection ${connection.id}: ${String(err)}`);
    }
  }

  /**
   * CAL-001 "write-back capability... requested only when user enables write-back" — the toggle's
   * server-side half. Turning it off is always allowed (no scope concerns). Turning it on requires the
   * connection's `scopes` to already contain the provider's write scope; if it doesn't (true for every
   * calendar connection made before this feature existed, and every fresh connect that didn't check the
   * "also allow write access" box), this throws `WRITE_SCOPE_REQUIRED` instead of silently flipping a flag
   * that would then have every real provider write fail with a 403 — the client is expected to catch that
   * code and start the reconnect-with-broader-scope flow (`GET .../authorize?writeBack=true&reconnectId=...`).
   */
  async setWriteBack(connectionId: string, userId: string, enabled: boolean): Promise<void> {
    const connection = await this.getOwned(connectionId, userId);
    if (!(connection.provider in REQUIRED_WRITE_SCOPE)) {
      throw new BadRequestException({ code: "UNSUPPORTED_PROVIDER", message: "Write-back isn't supported for this connection type." });
    }
    if (!enabled) {
      await this.db.update(schema.connections).set({ writeBackEnabled: false, updatedAt: new Date() }).where(eq(schema.connections.id, connectionId));
      return;
    }
    const requiredScope = REQUIRED_WRITE_SCOPE[connection.provider];
    if (!requiredScope || !connection.scopes.includes(requiredScope)) {
      throw new ConflictException({
        code: "WRITE_SCOPE_REQUIRED",
        message: "Reconnect this calendar to grant Veynlo permission to create events on it before turning on write-back.",
      });
    }
    await this.db.update(schema.connections).set({ writeBackEnabled: true, updatedAt: new Date() }).where(eq(schema.connections.id, connectionId));
  }

  /** PRIV-001 "per-source AI-processing toggle" — `enabled: null` clears the override and goes back to
   * inheriting `users.aiProcessingEnabled` (see connectors.ts schema doc comment); true/false pins this
   * connection independently of the global setting. See IngestionService.classifyAndExtract for where
   * this is actually read. */
  async setAiProcessingOverride(connectionId: string, userId: string, enabled: boolean | null): Promise<void> {
    await this.getOwned(connectionId, userId);
    await this.db.update(schema.connections).set({ aiProcessingEnabled: enabled, updatedAt: new Date() }).where(eq(schema.connections.id, connectionId));
  }

  /** PRIV-001 "pause/resume a connection without disconnecting it" — see connectors.ts's `paused` column
   * doc comment. Deliberately doesn't touch `health`/`disconnectedAt`/credentials: pausing is reversible
   * and non-destructive, purely a "stop scanning this on the recurring tick" flag (worker-main.ts's
   * connectorScanWorker is the only place that reads it). */
  async setPaused(connectionId: string, userId: string, paused: boolean): Promise<void> {
    await this.getOwned(connectionId, userId);
    await this.db
      .update(schema.connections)
      .set({ paused, pausedAt: paused ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.connections.id, connectionId));
  }

  /** PRIV-001 "exclude specific senders" — see connection_exclusions' own doc comment for the matching
   * granularity. Listed/added/removed per-connection, ownership-checked the same way every other mutation
   * on this service is. */
  async listExclusions(connectionId: string, userId: string) {
    await this.getOwned(connectionId, userId);
    return this.db
      .select()
      .from(schema.connectionExclusions)
      .where(eq(schema.connectionExclusions.connectionId, connectionId))
      .orderBy(asc(schema.connectionExclusions.createdAt));
  }

  async addExclusion(connectionId: string, userId: string, rawDomain: string) {
    await this.getOwned(connectionId, userId);
    const domain = normalizeSenderDomain(rawDomain);
    if (!domain) {
      throw new BadRequestException({ code: "INVALID_SENDER_DOMAIN", message: "Enter a valid sender domain (e.g. newsletter.example.com)." });
    }
    // Idempotent: re-adding an already-excluded domain is a no-op, not a duplicate row.
    const [existing] = await this.db
      .select({ id: schema.connectionExclusions.id })
      .from(schema.connectionExclusions)
      .where(and(eq(schema.connectionExclusions.connectionId, connectionId), eq(schema.connectionExclusions.excludedSenderDomain, domain)))
      .limit(1);
    if (existing) return existing;
    const id = generateId("connectionExclusion");
    await this.db.insert(schema.connectionExclusions).values({ id, connectionId, excludedSenderDomain: domain });
    return { id, connectionId, excludedSenderDomain: domain };
  }

  async removeExclusion(connectionId: string, userId: string, exclusionId: string): Promise<void> {
    await this.getOwned(connectionId, userId);
    await this.db
      .delete(schema.connectionExclusions)
      .where(and(eq(schema.connectionExclusions.id, exclusionId), eq(schema.connectionExclusions.connectionId, connectionId)));
  }

  /**
   * PRIV-001 "pause a connection's processing without fully disconnecting it" — the recurring
   * incremental-scan tick's own eligibility query (previously inlined directly in worker-main.ts's
   * connectorScanWorker), extracted here purely so it's unit-testable without a live BullMQ/Redis worker
   * process: a test can seed connections directly and assert on this method's return value instead of
   * having to actually run the queue. `paused` is independent of `health`/`disconnectedAt` — a paused
   * connection keeps its credential and already-synced data; it just stops being returned here until
   * resumed (`setPaused` above).
   *
   * §43.3 "Rate limited... auto-recovers... rather than needing manual reset" — this used to only allow
   * `health = "healthy"`, which meant a connection marked `rate_limited`/`provider_outage`/`degraded`/
   * `permission_reduced` would NEVER be retried again (nothing would ever attempt the "next successful
   * sync" whose own unconditional `health: "healthy"` write is what actually clears those states). Now
   * allows every health in RETRIED_HEALTH_STATES — every state except `reauth_required` (stop unauthorized
   * fetches until the user reconnects), `disconnected`, and `initializing` (still mid-backfill).
   */
  async listEligibleForIncrementalScan(): Promise<{ id: string }[]> {
    return this.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          inArray(schema.connections.provider, INCREMENTAL_SYNC_PROVIDERS),
          inArray(schema.connections.health, RETRIED_HEALTH_STATES),
          isNull(schema.connections.disconnectedAt),
          eq(schema.connections.paused, false),
        ),
      );
  }

  async assertOwnership(connectionId: string, userId: string) {
    const connection = await this.getOwned(connectionId, userId);
    if (connection.ownerUserId !== userId) {
      throw new ForbiddenException({ code: "NOT_OWNER", message: "You do not own this connection." });
    }
    return connection;
  }
}
