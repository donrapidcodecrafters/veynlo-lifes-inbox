import { Inject, Injectable, Logger, BadRequestException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DAVClient } from "tsdav";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { CredentialVault } from "../../common/credential-vault";
import { EntitlementsService } from "../entitlements/entitlements.service";
import { QUEUE_PRODUCER, type QueueProducer } from "../../queue/queue-producer.interface";
import { findDavProvider } from "./dav-providers";
import { CalDavAdapter, type DavConnectDto } from "./caldav.adapter";
import { parseVCard } from "./vcard";
import { buildContactSyncIndexes, upsertContact } from "./contact-sync";
import type { ConnectorAdapter } from "./connector.interface";

/**
 * CardDAV — contacts from anything that is not Google or Microsoft.
 *
 * Closes the spec's "CardDAV" row and, more usefully, its "Apple Contacts" one. The register classes Apple
 * Contacts A/B/C and the mobile app already covers the B reading: a device picker where the user chooses
 * individual contacts to import. That is deliberate and stays — it is the right shape for a phone. But it
 * is manual, one-device and one-shot, and iCloud also speaks plain CardDAV with the same app-specific
 * password iCloud Calendar uses. A server-side contacts connection that keeps itself current is a
 * different feature, and this app should have both.
 *
 * Almost nothing here is new. Server resolution and its refusals are `CalDavAdapter.resolveServer` —
 * including the one quirk that matters, that Apple serves contacts from a DIFFERENT host than calendars
 * while sharing one credential. vCards are read by `vcard.ts`. Rows are written by `contact-sync.ts`, the
 * same code Google Contacts uses, so a CardDAV contact gets the same identity rules: never destroyed when
 * it disappears upstream, private by default, and keyed on the provider's own id rather than a matching
 * email address.
 */

/** One sync's ceiling across all address books on the account. */
const MAX_CONTACTS_PER_SYNC = 2_000;

interface DavCredentials {
  serverUrl: string;
  username: string;
  password: string;
  providerKey: string;
}

@Injectable()
export class CardDavAdapter implements ConnectorAdapter {
  private readonly logger = new Logger(CardDavAdapter.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(EntitlementsService) private readonly entitlements: EntitlementsService,
    @Inject(QUEUE_PRODUCER) private readonly queue: QueueProducer,
  ) {}

  isConfigured(): boolean {
    return true;
  }

  private client(creds: { serverUrl: string; username: string; password: string }): DAVClient {
    return new DAVClient({
      serverUrl: creds.serverUrl,
      credentials: { username: creds.username, password: creds.password },
      authMethod: "Basic",
      defaultAccountType: "carddav",
    });
  }

  /**
   * Verify by logging in and finding at least one address book, then store.
   *
   * Discovery is part of the check for the same reason it is on the calendar side: a login that succeeds
   * but exposes nothing leaves a connection that looks healthy and produces nothing forever.
   */
  async connect(params: { dto: DavConnectDto; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    // PEO-001 — contacts are Core-tier and deliberately NOT quota-gated, matching the decision already
    // recorded on google-contacts.adapter.ts and the controller's contacts authorize routes. Adding a
    // "contacts" category to assertConnectorQuota here would quietly impose a cap the plan catalog never
    // declared, on the one connector family the spec treats as always-available.
    const serverUrl = await CalDavAdapter.resolveServer(params.dto, "carddav");

    const username = params.dto.username.trim();
    if (!username || !params.dto.password) {
      throw new BadRequestException({ code: "DAV_CREDENTIALS_REQUIRED", message: "Enter both your username and password." });
    }

    const client = this.client({ serverUrl, username, password: params.dto.password });
    try {
      await client.login();
      const addressBooks = await client.fetchAddressBooks();
      if (!addressBooks || addressBooks.length === 0) {
        throw new BadRequestException({
          code: "DAV_NO_ADDRESS_BOOKS",
          message: "Signed in, but that account has no address books we can read.",
        });
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      const provider = findDavProvider(params.dto.providerKey);
      this.logger.warn(`CardDAV connect failed for provider ${params.dto.providerKey}: ${(err as Error)?.name ?? "error"}`);
      throw new BadRequestException({
        code: "DAV_CONNECT_FAILED",
        message: provider?.credentialHint ?? "Couldn't sign in to that server. Check the address, username and password.",
      });
    }

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "carddav",
      feasibilityClass: "open_standard",
      scopes: ["contacts.read"],
      enabledCategories: ["people"],
      health: "initializing",
    });

    const credentials: DavCredentials & Record<string, unknown> = {
      serverUrl,
      username,
      password: params.dto.password,
      providerKey: params.dto.providerKey,
    };
    const credentialRef = await this.vault.store(connectionId, credentials, null);
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
    const creds = (await this.vault.read(connection.credentialRef)) as DavCredentials | null;
    if (!creds) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);

    const client = this.client(creds);
    let itemCount = 0;

    try {
      await client.login();
      const addressBooks = await client.fetchAddressBooks();

      // Built ONCE per sync, from decrypted rows — see contact-sync.ts for why, and for what it cost when
      // this lookup was a SQL comparison against an encrypted column.
      const indexes = await buildContactSyncIndexes(this.db, {
        ownerUserId: connection.ownerUserId,
        connectionId,
        provider: "carddav",
      });

      let seen = 0;
      for (const addressBook of addressBooks ?? []) {
        if (seen >= MAX_CONTACTS_PER_SYNC) break;

        let cards;
        try {
          cards = await client.fetchVCards({ addressBook });
        } catch (err) {
          // One unreadable address book must not cost the rest of the account its sync.
          this.logger.warn(`Skipping an address book on connection ${connectionId}: ${String((err as Error)?.message ?? err)}`);
          continue;
        }

        for (const card of cards ?? []) {
          if (seen >= MAX_CONTACTS_PER_SYNC) break;
          if (!card.data) continue;
          seen++;

          // The object's URL on the server, not the vCard's own UID: the URL is what CardDAV guarantees is
          // unique and stable within an address book, and a UID is not always present.
          const providerContactId = String(card.url ?? "").trim();
          if (!providerContactId) continue;

          const contact = parseVCard(String(card.data), providerContactId);
          // A card with no name and no way to reach anyone is not a contact worth creating.
          if (!contact) continue;

          try {
            const created = await upsertContact(this.db, {
              ownerUserId: connection.ownerUserId,
              householdId: connection.householdId,
              connectionId,
              provider: "carddav",
              contact,
              indexes,
            });
            if (created) itemCount++;
          } catch (err) {
            this.logger.warn(`Failed to file a contact on connection ${connectionId}: ${String((err as Error)?.message ?? err)}`);
          }
        }
      }

      await this.db
        .update(schema.connections)
        .set({ health: "healthy", healthDetail: null, lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount })
        .where(eq(schema.connections.id, connectionId));
    } catch (err) {
      const authFailed = /401|403|unauthorized|forbidden/i.test(String((err as Error)?.message ?? ""));
      await this.db
        .update(schema.connections)
        .set({
          health: authFailed ? "reauth_required" : "degraded",
          healthDetail: authFailed
            ? "Your server rejected the saved password. App passwords are often revoked when you change your account password — generate a new one and reconnect."
            : "Couldn't reach your contacts server on the last sync.",
        })
        .where(eq(schema.connections.id, connectionId));
      throw err;
    }

    return { itemCount };
  }
}
