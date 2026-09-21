import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CredentialVault } from "../../common/credential-vault";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { IngestionService } from "../ingestion/ingestion.service";
import { assertHostnameIsPublic } from "../ingestion/safe-url-fetcher";
import { findImapProvider } from "./imap-providers";
import type { ConnectorAdapter } from "./connector.interface";

/**
 * IMAP — the six email targets that had no way in at all.
 *
 * Spec Appendix A names eight email providers. Gmail and Outlook were built, both over OAuth. Yahoo,
 * iCloud, AOL, Fastmail, Proton and "generic IMAP/custom domain" were not, which meant a user on any of
 * them could sign up and find nothing on the Connections screen they could actually connect. Email is
 * this app's primary sense organ; for those users it had no eyes.
 *
 * IMAP is spec feasibility class C — an open standard. No partner agreement, no OAuth app registration,
 * no review queue. What it costs instead is that this adapter holds a real mailbox credential, and a
 * user-supplied server address, and must be careful about both.
 *
 * ---------------------------------------------------------------------------------------------------
 * The two things that make this different from every other connector here
 * ---------------------------------------------------------------------------------------------------
 *
 * 1. THE HOST COMES FROM THE USER. Every other adapter talks to an address this codebase hardcoded.
 *    Here, "mail.example.com" and "169.254.169.254" arrive through the same text field, so the hostname
 *    is resolved and checked against private/reserved ranges before a socket is opened —
 *    `assertHostnameIsPublic`, the same guard the URL-capture fetcher uses, rather than a second
 *    implementation of it. TLS is required and never downgraded: a mail password must not cross a
 *    network in the clear, so a server that cannot offer TLS is a server this app declines.
 *
 * 2. IT HOLDS A PASSWORD, not a revocable token. It goes into the same encrypted CredentialVault every
 *    other connector's secret does and is never logged, never returned by any endpoint, and never put in
 *    an error message. The providers this targets all issue app-specific passwords for exactly this
 *    purpose, which is what `imap-providers.ts` exists to explain to each user in their own provider's
 *    terms — "authentication failed" is a useless answer when the real one is "Yahoo needs an app
 *    password and here is where to make one".
 *
 * ---------------------------------------------------------------------------------------------------
 * Sync
 * ---------------------------------------------------------------------------------------------------
 * UID-based, the IMAP equivalent of Gmail's historyId and Plaid's cursor. `connections.cursor` holds
 * `{ uidValidity, lastUid }`. A server that changes UIDVALIDITY has renumbered the mailbox and every
 * stored UID is meaningless — the spec's own reconciliation language — so that is detected and treated as
 * a fresh start rather than silently fetching the wrong messages.
 *
 * Message bodies are parsed with mailparser and handed to the same `ingestParsedEmail` path Gmail and
 * Outlook use. That matters more than it looks: it means an IMAP mailbox gets the attachment pipeline,
 * the relevance gate, sender rules, dedup, and — because mailparser gives us the HTML part intact — the
 * schema.org markup reading, all without a line of duplicated logic.
 */

const MAILBOX = "INBOX";
/** One sync's ceiling. A ten-year Yahoo mailbox must not become one unbounded fetch. */
const MAX_MESSAGES_PER_SYNC = 200;
const CONNECT_TIMEOUT_MS = 20_000;

interface ImapCredentials {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  providerKey: string;
}

interface ImapCursor {
  uidValidity: string;
  lastUid: number;
}

export interface ImapConnectDto {
  providerKey: string;
  username: string;
  password: string;
  /** Only read for the "custom" provider; every other key carries its own verified host/port. */
  host?: string;
  port?: number;
  requestedHistoryDepthDays?: number;
}

@Injectable()
export class ImapAdapter implements ConnectorAdapter {
  private readonly logger = new Logger(ImapAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
    @Inject(IngestionService) private readonly ingestion: IngestionService,
  ) {}

  /**
   * Unlike every other connector, this one needs no deployment credential of its own — there is no app to
   * register and no client secret to hold. It is available the moment the service is running, which is
   * also why it is the only email path that works in this dev environment.
   */
  isConfigured(): boolean {
    return true;
  }

  private async resolveTarget(dto: ImapConnectDto): Promise<{ host: string; port: number; secure: boolean }> {
    const provider = findImapProvider(dto.providerKey);
    if (!provider) {
      throw new BadRequestException({ code: "UNKNOWN_IMAP_PROVIDER", message: "That mail provider isn't one we recognise." });
    }
    if (provider.unavailableReason) {
      // Proton. Refusing with the real reason, rather than letting the user watch a connection attempt
      // fail against an endpoint that does not exist.
      throw new BadRequestException({ code: "IMAP_PROVIDER_UNAVAILABLE", message: provider.unavailableReason });
    }

    const host = (provider.key === "custom" ? dto.host : provider.host)?.trim();
    const port = provider.key === "custom" ? (dto.port ?? 993) : provider.port;
    if (!host) {
      throw new BadRequestException({ code: "IMAP_HOST_REQUIRED", message: "Enter your provider's IMAP server address." });
    }
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new BadRequestException({ code: "IMAP_PORT_INVALID", message: "That IMAP port isn't valid." });
    }

    // The user typed this. Resolve it and refuse anything internal BEFORE a socket exists.
    //
    // The shared guard words its refusal for the URL-capture feature it was written for ("Couldn't reach
    // that URL"), which reads wrong against a field labelled "IMAP server" — this is a mail host, not a
    // URL. The CODE is kept identical so the guard stays one behaviour with one meaning; only the sentence
    // shown to the user changes. It still refuses to confirm that the address was internal.
    try {
      await assertHostnameIsPublic(host);
    } catch {
      throw new BadRequestException({
        code: "URL_UNREACHABLE",
        message: "Couldn't reach that mail server. Check the address and try again.",
      });
    }

    return { host, port, secure: true };
  }

  private client(creds: { host: string; port: number; secure: boolean; username: string; password: string }): ImapFlow {
    return new ImapFlow({
      host: creds.host,
      port: creds.port,
      // Never negotiated down. A mail password in the clear is not a tradeoff this app offers.
      secure: creds.secure,
      auth: { user: creds.username, pass: creds.password },
      // imapflow logs the full IMAP conversation at info level by default, which includes the LOGIN
      // command. That is a credential in a log file; off, permanently.
      logger: false,
      tls: { rejectUnauthorized: true },
      greetingTimeout: CONNECT_TIMEOUT_MS,
      socketTimeout: CONNECT_TIMEOUT_MS * 3,
    });
  }

  /**
   * Verify the credential by actually logging in, then store it.
   *
   * Deliberately proves the connection before writing anything: a connection row that has never
   * successfully authenticated is a row that will sit in the user's Connections list looking healthy and
   * doing nothing, which is exactly the "false caught-up state" the spec forbids.
   */
  async connect(params: { dto: ImapConnectDto; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    await this.entitlements.assertConnectorQuota(params.ownerUserId, "email");
    const target = await this.resolveTarget(params.dto);

    const username = params.dto.username.trim();
    if (!username || !params.dto.password) {
      throw new BadRequestException({ code: "IMAP_CREDENTIALS_REQUIRED", message: "Enter both your email address and password." });
    }

    const client = this.client({ ...target, username, password: params.dto.password });
    try {
      await client.connect();
      // Open it read-only — this connector reads mail and must never mark it seen or move it.
      const lock = await client.getMailboxLock(MAILBOX, { readOnly: true });
      lock.release();
    } catch (err) {
      // Never echo the provider's raw error: it can contain the attempted username, and on some servers
      // the command that failed. The provider-specific hint is far more useful anyway.
      const provider = findImapProvider(params.dto.providerKey);
      this.logger.warn(`IMAP connect failed for provider ${params.dto.providerKey}: ${(err as Error)?.name ?? "error"}`);
      throw new BadRequestException({
        code: "IMAP_CONNECT_FAILED",
        message: provider?.credentialHint ?? "Couldn't sign in to that mailbox. Check the address and password and try again.",
      });
    } finally {
      await client.logout().catch(() => {});
    }

    const connectionId = generateId("connection");
    const historyDepthDays = await this.entitlements.resolveHistoricalBackfillDays(params.ownerUserId, params.dto.requestedHistoryDepthDays);
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "imap",
      feasibilityClass: "open_standard",
      // IMAP has no scope vocabulary — the credential grants mailbox access, full stop. Recorded as what
      // this app actually does with it, which is what PRIV-001's "granted scopes" display is for.
      scopes: ["mail.read"],
      enabledCategories: ["purchases", "bills", "appointments"],
      health: "initializing",
      historyDepthDays,
    });

    const credentials: ImapCredentials & Record<string, unknown> = {
      host: target.host,
      port: target.port,
      secure: target.secure,
      username,
      password: params.dto.password,
      providerKey: params.dto.providerKey,
    };
    const credentialRef = await this.vault.store(connectionId, credentials, null);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    await this.queue.enqueueConnectorSync({ connectionId, kind: "initial" });
    return { connectionId };
  }

  private async credentials(connectionId: string): Promise<{ connection: typeof schema.connections.$inferSelect; creds: ImapCredentials }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const creds = await this.vault.read(connection.credentialRef);
    if (!creds) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    return { connection, creds: creds as unknown as ImapCredentials };
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId, true);
  }

  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    return this.sync(connectionId, false);
  }

  private parseCursor(raw: string | null): ImapCursor | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<ImapCursor>;
      if (typeof parsed.uidValidity !== "string" || typeof parsed.lastUid !== "number") return null;
      return { uidValidity: parsed.uidValidity, lastUid: parsed.lastUid };
    } catch {
      // A cursor we cannot read is treated as absent rather than fatal — the next sync re-establishes it.
      return null;
    }
  }

  private async sync(connectionId: string, isInitial: boolean): Promise<{ itemCount: number }> {
    const { connection, creds } = await this.credentials(connectionId);
    const client = this.client(creds);
    let itemCount = 0;

    try {
      await client.connect();
      const lock = await client.getMailboxLock(MAILBOX, { readOnly: true });
      try {
        const mailbox = client.mailbox;
        if (!mailbox || typeof mailbox === "boolean") throw new Error("mailbox did not open");

        const uidValidity = String(mailbox.uidValidity);
        const stored = this.parseCursor(connection.cursor);

        // UIDVALIDITY changing means the server renumbered the mailbox and every UID we remember now
        // refers to a different message — or to none. Continuing from the old number would silently fetch
        // the wrong mail. Treated as a fresh start, which is the only correct reading of it.
        const cursorUsable = stored !== null && stored.uidValidity === uidValidity;
        if (stored !== null && !cursorUsable) {
          this.logger.warn(`UIDVALIDITY changed for connection ${connectionId} — restarting from the configured history window`);
        }

        // null means "nothing in the window to fetch" — distinct from "fetch this range".
        let range: string | null;
        if (cursorUsable && !isInitial) {
          range = `${stored.lastUid + 1}:*`;
        } else {
          // Bounded by the plan's historical depth, exactly like every other connector's backfill.
          const days = connection.historyDepthDays ?? 90;
          const since = new Date(Date.now() - days * 86_400_000);
          const uids = await client.search({ since }, { uid: true });
          // An empty result is a perfectly healthy mailbox with no mail in the window — a brand new
          // account, or a quiet one. The first version of this returned from inside the lock here, which
          // skipped the cursor and health write below and left the connection reading "initializing"
          // forever: a working connection that permanently looks like it is still starting up. The spec
          // calls that out by name as a false state a user must never be shown.
          range = !uids || uids.length === 0 ? null : uids.slice(-MAX_MESSAGES_PER_SYNC).join(",");
        }

        let highestUid = cursorUsable ? stored.lastUid : 0;
        let fetched = 0;

        for await (const message of range === null ? [] : client.fetch(range, { uid: true, source: true }, { uid: true })) {
          // IMAP normalises a range whose start exceeds the highest UID: ask for "5:*" on a mailbox whose
          // newest message is 4 and the server reads it as "4:5" and hands back message 4. So a cursor-based
          // fetch ALWAYS returns at least one message, even when nothing has arrived.
          //
          // Found by running this against a real server. Dedup downstream meant no duplicate record was
          // ever written, so the only visible symptom was a sync that reported one item every time and
          // re-fetched, re-parsed and re-hashed the same message forever. A mocked IMAP client would have
          // returned exactly what this code asked for and shown nothing.
          if (cursorUsable && !isInitial && stored !== null && message.uid <= stored.lastUid) continue;
          if (fetched >= MAX_MESSAGES_PER_SYNC) break;
          fetched++;
          if (message.uid > highestUid) highestUid = message.uid;
          if (!message.source) continue;

          try {
            const mail = await simpleParser(message.source);
            await this.ingestion.ingestImapMessage({
              ownerUserId: connection.ownerUserId,
              householdId: connection.householdId,
              connectionId,
              uid: message.uid,
              subject: mail.subject ?? "",
              fromAddress: mail.from?.value?.[0]?.address ?? "",
              toAddress: Array.isArray(mail.to) ? (mail.to[0]?.value?.[0]?.address ?? "") : (mail.to?.value?.[0]?.address ?? ""),
              dateHeader: mail.date ? mail.date.toUTCString() : "",
              bodyText: mail.text ?? "",
              // The reason an IMAP mailbox gets schema.org markup reading for free: mailparser hands back
              // the HTML part intact rather than a tag-stripped approximation of it.
              bodyHtml: typeof mail.html === "string" ? mail.html : null,
              headers: Object.fromEntries([...mail.headers.entries()].map(([k, v]) => [k, typeof v === "string" ? v : String(v)])),
              isBackfill: isInitial,
            });
            itemCount++;
          } catch (err) {
            // One unparseable message must not cost the rest of the sync. Logged by UID, never by content.
            this.logger.warn(`Skipping IMAP message uid=${message.uid} on connection ${connectionId}: ${String((err as Error)?.message ?? err)}`);
          }
        }

        await this.db
          .update(schema.connections)
          .set({
            cursor: JSON.stringify({ uidValidity, lastUid: highestUid } satisfies ImapCursor),
            health: "healthy",
            healthDetail: null,
            lastSuccessfulSyncAt: new Date(),
          })
          .where(eq(schema.connections.id, connectionId));
      } finally {
        lock.release();
      }
    } catch (err) {
      // An auth failure here is a credential that has been revoked or rotated at the provider — the
      // "reauthorization required" state in §43.3's health model, not a transient fault to retry forever.
      const authFailed = /AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed/i.test(String((err as Error)?.message ?? ""));
      await this.db
        .update(schema.connections)
        .set({
          health: authFailed ? "reauth_required" : "degraded",
          healthDetail: authFailed
            ? "Your mail provider rejected the saved password. App passwords are often revoked when you change your account password — generate a new one and reconnect."
            : "Couldn't reach your mail server on the last sync.",
        })
        .where(eq(schema.connections.id, connectionId));
      throw err;
    } finally {
      await client.logout().catch(() => {});
    }

    return { itemCount };
  }

  /** Nothing to revoke at the provider — an app password is withdrawn in the provider's own settings, by
   * the user. Deleting the stored credential is the whole of what this side can do, and the disconnect
   * path already does that. */
  async revoke(): Promise<void> {
    return;
  }
}
