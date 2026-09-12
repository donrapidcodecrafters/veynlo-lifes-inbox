import { Inject, Injectable } from "@nestjs/common";
import { google, type people_v1 } from "googleapis";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";
import { recordConnectorSyncFailure } from "./connection-health.util";

// PEO-001 "Connect Google Contacts... when permission is granted" — reuses the SAME
// GOOGLE_OAUTH_CLIENT_ID/SECRET Gmail/Google Calendar already use (one Google Cloud OAuth app, an
// additional consent scope), exactly the way google-calendar.adapter.ts reuses Gmail's own client
// credentials for its own separate `provider: "google_contacts"` connection. Read-only — PEO-001 has no
// write-back concept for contacts the way CAL-001 does for calendar events.
const CONTACTS_SCOPES = ["https://www.googleapis.com/auth/contacts.readonly"];
const PERSON_FIELDS = "names,emailAddresses,phoneNumbers,organizations,metadata";

interface ParsedContact {
  providerContactId: string;
  displayName: string;
  emails: string[];
  phones: string[];
  organizationName: string | null;
  deleted: boolean;
}

function parsePerson(person: people_v1.Schema$Person): ParsedContact | null {
  const resourceName = person.resourceName;
  if (!resourceName) return null;
  const displayName = person.names?.[0]?.displayName?.trim() || null;
  return {
    providerContactId: resourceName,
    displayName: displayName ?? "Unnamed contact",
    emails: (person.emailAddresses ?? []).map((e) => e.value).filter((v): v is string => Boolean(v)),
    phones: (person.phoneNumbers ?? []).map((p) => p.value).filter((v): v is string => Boolean(v)),
    organizationName: person.organizations?.[0]?.name?.trim() || null,
    deleted: Boolean(person.metadata?.deleted),
  };
}

/**
 * §14 "Contacts, People & Relationships" (PEO-001) — direct-API connector for Google Contacts (the People
 * API), a separate `provider: "google_contacts"` connection from Gmail/Google Calendar, same shape as those
 * two: OAuth authorize/callback → `initialSync` (full pull) → `incrementalSync` (Google's own
 * `syncToken` pagination, exactly like GoogleCalendarAdapter's `events.list` syncToken).
 *
 * Deliberately does NOT go through IngestionService the way Gmail/GoogleCalendar do — a contact needs no AI
 * domain classification or extraction step, it maps directly onto `people`/`aliases`/`contactSources`.
 * Deliberately does NOT alias-match a newly-synced contact into an existing person at import time, even
 * when its email/phone matches one already on file — PEO-002 "ambiguous merges require review": every new
 * provider contact becomes its own `people` row + `contactSources` row, and `PeopleService.findMergeCandidates`
 * /`mergePeople` is the one, human-reviewed path two rows for the same real person ever get combined.
 */
@Injectable()
export class GoogleContactsAdapter implements OAuthConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
  ) {}

  private oauthClient(redirectUri: string) {
    const env = loadEnv();
    return new google.auth.OAuth2(env.GOOGLE_OAUTH_CLIENT_ID, env.GOOGLE_OAUTH_CLIENT_SECRET, redirectUri);
  }

  isConfigured(): boolean {
    return isConnectorConfigured("google");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_contacts");
    const client = this.oauthClient(params.redirectUri);
    return client.generateAuthUrl({
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: true,
      scope: CONTACTS_SCOPES,
      state: params.state,
    });
  }

  async handleCallback(params: { code: string; redirectUri: string; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("google_contacts");
    const client = this.oauthClient(params.redirectUri);
    const { tokens } = await client.getToken(params.code);

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "google_contacts",
      feasibilityClass: "direct_api",
      scopes: tokens.scope ? tokens.scope.split(" ") : CONTACTS_SCOPES,
      enabledCategories: ["people"],
      health: "initializing",
      // PEO-001 gates on plan quota deliberately NOT enforced here — Contacts is Core-tier, unlike the
      // email/calendar/storage/financial categories EntitlementsService.assertConnectorQuota gates (see
      // ConnectorsController's google-contacts/microsoft-contacts authorize routes' own comment).
      historyDepthDays: null,
    });
    const credentialRef = await this.vault.store(
      connectionId,
      { access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope },
      tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    );
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    // Contacts sync runs synchronously on connect (a person's whole address book is small relative to a
    // mailbox) rather than through the queue producer's connector-sync job — mirrors IcsAdapter.connect's
    // own "just do it inline" shape rather than every OAuth adapter's enqueue-then-worker-picks-it-up path,
    // since there's no AI extraction step here to make async worth it.
    await this.initialSync(connectionId);
    return { connectionId };
  }

  private async client(connectionId: string) {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error(`Connection ${connectionId} has a credentialRef with no matching vault entry`);
    const oauth = this.oauthClient(`${loadEnv().API_PUBLIC_URL}/v1/connectors/google-contacts/callback`);
    oauth.setCredentials(credentials);
    return { connection, people: google.people({ version: "v1", auth: oauth }) };
  }

  /** Upserts one Google contact into `people`/`aliases`/`contactSources` — see this class's own doc comment
   * on why this never alias-matches into an existing person at import time. */
  /**
   * Indexes for the two lookups this sync needs, built ONCE per sync from decrypted rows.
   *
   * Both used to be SQL predicates on columns that are encrypted at rest — `contactSources
   * .providerContactId` and `organizations.name`. Drizzle only decrypts on the way out
   * (`fromDriver`), and `encryptField` uses a fresh random IV per write, so those comparisons matched
   * a plaintext string against ciphertext and could never be true. Proven against the real database
   * inside a rolled-back transaction: insert a row, read it back by id and its decrypted
   * providerContactId is exactly the value written; query for that same value and it returns 0 rows.
   *
   * The consequence was not a missing feature, it was compounding corruption: `existingSource` was
   * always undefined, so every sync took the "new contact" branch and inserted another person row and
   * another contact-source row for every contact in the address book, every time. The update branch
   * (refresh displayName, bump syncedAt) was unreachable, so a renamed contact spawned a duplicate
   * instead of updating; the deletion branch was unreachable, so a removed contact was never marked;
   * and `return !existingSource` was always true, reporting the entire address book as newly
   * discovered on every run. Organizations duplicated the same way.
   *
   * Built once and mutated as rows are inserted, so duplicates inside a single sync are caught too.
   * One query each, rather than one per contact — matching in JS after decryption is the only way to
   * compare these columns, and doing it per contact would be quadratic on a large address book.
   */
  private async syncIndexes(connection: typeof schema.connections.$inferSelect, connectionId: string) {
    const sourceRows = await this.db
      .select()
      .from(schema.contactSources)
      .where(and(eq(schema.contactSources.connectionId, connectionId), eq(schema.contactSources.provider, "google")));
    const organizationRows = await this.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.ownerUserId, connection.ownerUserId));
    return {
      sources: new Map(sourceRows.filter((r) => r.providerContactId).map((r) => [r.providerContactId as string, r])),
      organizations: new Map(organizationRows.map((r) => [r.name, r.id])),
    };
  }

  private async upsertContact(
    connection: typeof schema.connections.$inferSelect,
    connectionId: string,
    contact: ParsedContact,
    indexes: Awaited<ReturnType<GoogleContactsAdapter["syncIndexes"]>>,
  ): Promise<boolean> {
    const existingSource = indexes.sources.get(contact.providerContactId);

    if (contact.deleted) {
      // Contact sources remain evidence of what was once synced; the canonical Person row (and any notes/
      // relationships/history a user attached to it) is never destroyed just because it disappeared from a
      // provider's address book — same "don't destroy user data on an external signal" stance
      // GoogleCalendarAdapter takes for a cancelled event, applied to the more destructive case of a
      // person's whole row. Just stop tracking it as still-synced.
      if (existingSource) await this.db.update(schema.contactSources).set({ syncedAt: new Date() }).where(eq(schema.contactSources.id, existingSource.id));
      return false;
    }

    let personId: string;
    if (existingSource) {
      personId = existingSource.personId;
      await this.db.update(schema.contactSources).set({ syncedAt: new Date() }).where(eq(schema.contactSources.id, existingSource.id));
      await this.db.update(schema.people).set({ displayName: contact.displayName, updatedAt: new Date() }).where(eq(schema.people.id, personId));
    } else {
      personId = generateId("person");
      await this.db.insert(schema.people).values({
        id: personId,
        ownerUserId: connection.ownerUserId,
        householdId: connection.householdId,
        displayName: contact.displayName,
        // PEO-001 "avoid sensitive identity inference beyond product need" — private by default, exactly
        // like a manually-created person (PeopleService.create); a synced contact isn't household-visible
        // just because it came from a household-linked connection.
        visibility: "private",
      });
      const contactSourceId = generateId("contactSource");
      const inserted = {
        id: contactSourceId,
        personId,
        ownerUserId: connection.ownerUserId,
        provider: "google" as const,
        connectionId,
        providerContactId: contact.providerContactId,
        syncedAt: new Date(),
      };
      await this.db.insert(schema.contactSources).values(inserted);
      indexes.sources.set(contact.providerContactId, inserted as (typeof indexes.sources) extends Map<string, infer V> ? V : never);
    }

    if (contact.organizationName) {
      const existingOrganizationId = indexes.organizations.get(contact.organizationName);
      const organizationId = existingOrganizationId ?? generateId("organization");
      if (!existingOrganizationId) {
        await this.db.insert(schema.organizations).values({ id: organizationId, ownerUserId: connection.ownerUserId, name: contact.organizationName });
        indexes.organizations.set(contact.organizationName, organizationId);
      }
      await this.db.update(schema.people).set({ organizationId }).where(eq(schema.people.id, personId));
    }

    const existingAliases = await this.db.select().from(schema.aliases).where(eq(schema.aliases.personId, personId));
    const existingValues = new Set(existingAliases.map((a) => `${a.kind}:${a.value}`));
    for (const email of contact.emails) {
      if (existingValues.has(`email:${email}`)) continue;
      await this.db.insert(schema.aliases).values({ id: generateId("alias"), personId, ownerUserId: connection.ownerUserId, kind: "email", value: email });
    }
    for (const phone of contact.phones) {
      if (existingValues.has(`phone:${phone}`)) continue;
      await this.db.insert(schema.aliases).values({ id: generateId("alias"), personId, ownerUserId: connection.ownerUserId, kind: "phone", value: phone });
    }
    return !existingSource;
  }

  async initialSync(connectionId: string): Promise<{ itemCount: number }> {
    try {
      const { connection, people } = await this.client(connectionId);

      // Built once per sync, not per contact — see syncIndexes.
      const indexes = await this.syncIndexes(connection, connectionId);
      let itemCount = 0;
      let pageToken: string | undefined;
      let nextSyncToken: string | null | undefined;
      do {
        const list = await people.people.connections.list({
          resourceName: "people/me",
          personFields: PERSON_FIELDS,
          pageSize: 200,
          pageToken,
          requestSyncToken: true,
        });
        for (const person of list.data.connections ?? []) {
          const parsed = parsePerson(person);
          if (!parsed) continue;
          if (await this.upsertContact(connection, connectionId, parsed, indexes)) itemCount += 1;
        }
        pageToken = list.data.nextPageToken ?? undefined;
        if (list.data.nextSyncToken) nextSyncToken = list.data.nextSyncToken;
      } while (pageToken);

      await this.db
        .update(schema.connections)
        .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: nextSyncToken ?? null })
        .where(eq(schema.connections.id, connectionId));
      return { itemCount };
    } catch (err) {
      // §43.3 — unlike Gmail/Calendar/Drive, this runs synchronously from `handleCallback` rather than
      // through worker-main.ts's connectorSyncWorker (google_contacts/microsoft_contacts are never part of
      // the recurring incremental-scan tick — see INCREMENTAL_SYNC_PROVIDERS' own list), so nothing else
      // records a failure here; without this, a failed sync left the connection stuck at `initializing`
      // forever with zero visibility instead of surfacing a real health state.
      await recordConnectorSyncFailure(this.db, connectionId, err, "google");
      throw err;
    }
  }

  /** Real incremental sync keyed off `people.connections.list`'s `syncToken` — same 410-Gone-means-
   * full-resync recovery as GoogleCalendarAdapter.incrementalSync. */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const { connection, people } = await this.client(connectionId);
    if (!connection.cursor) return this.initialSync(connectionId);

    // Built once per sync, not per contact — see syncIndexes.
    const indexes = await this.syncIndexes(connection, connectionId);
    let itemCount = 0;
    let pageToken: string | undefined;
    let nextSyncToken: string | null | undefined;
    try {
      do {
        const list = await people.people.connections.list({
          resourceName: "people/me",
          personFields: PERSON_FIELDS,
          pageSize: 200,
          pageToken,
          syncToken: connection.cursor,
        });
        for (const person of list.data.connections ?? []) {
          const parsed = parsePerson(person);
          if (!parsed) continue;
          if (await this.upsertContact(connection, connectionId, parsed, indexes)) itemCount += 1;
        }
        pageToken = list.data.nextPageToken ?? undefined;
        if (list.data.nextSyncToken) nextSyncToken = list.data.nextSyncToken;
      } while (pageToken);
    } catch (err) {
      const status = (err as { code?: number; response?: { status?: number } })?.code ?? (err as { response?: { status?: number } })?.response?.status;
      if (status === 410) return this.initialSync(connectionId);
      await recordConnectorSyncFailure(this.db, connectionId, err, "google");
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({
        health: "healthy",
        lastSuccessfulSyncAt: new Date(),
        itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount,
        cursor: nextSyncToken ?? connection.cursor,
      })
      .where(eq(schema.connections.id, connectionId));
    return { itemCount };
  }
}
