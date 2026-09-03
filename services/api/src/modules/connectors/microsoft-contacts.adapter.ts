import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { loadEnv, isConnectorConfigured } from "../../config/env";
import { CredentialVault } from "../../common/credential-vault";
import { ConnectorNotConfiguredError } from "./connector-errors";
import type { OAuthConnectorAdapter } from "./connector.interface";
import { oauthTokenRequestError, recordConnectorSyncFailure } from "./connection-health.util";

const AUTHORIZE_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
// PEO-001 "Connect... Microsoft contacts" — reuses the SAME MICROSOFT_OAUTH_CLIENT_ID/SECRET Outlook/
// Microsoft Calendar already use, one extra consent scope, same shape as MicrosoftCalendarAdapter.
const CONTACTS_SCOPES = ["offline_access", "Contacts.Read"];
const CONTACT_SELECT = "id,displayName,emailAddresses,businessPhones,homePhones,mobilePhone,companyName";

interface MicrosoftCredentials {
  access_token: string;
  refresh_token: string;
}

interface GraphContact {
  id?: string;
  displayName?: string;
  emailAddresses?: { address?: string }[];
  businessPhones?: string[];
  homePhones?: string[];
  mobilePhone?: string;
  companyName?: string;
  "@removed"?: { reason?: string };
}

interface ParsedContact {
  providerContactId: string;
  displayName: string;
  emails: string[];
  phones: string[];
  organizationName: string | null;
  deleted: boolean;
}

function parseContact(contact: GraphContact): ParsedContact | null {
  if (!contact.id) return null;
  const phones = [...(contact.businessPhones ?? []), ...(contact.homePhones ?? []), ...(contact.mobilePhone ? [contact.mobilePhone] : [])];
  return {
    providerContactId: contact.id,
    displayName: contact.displayName?.trim() || "Unnamed contact",
    emails: (contact.emailAddresses ?? []).map((e) => e.address).filter((v): v is string => Boolean(v)),
    phones,
    organizationName: contact.companyName?.trim() || null,
    deleted: Boolean(contact["@removed"]),
  };
}

/**
 * §14 "Contacts, People & Relationships" (PEO-001) — direct-API connector for Microsoft/Outlook Contacts
 * via Microsoft Graph, a separate `provider: "microsoft_contacts"` connection from Outlook mail/Microsoft
 * Calendar. Same shape as MicrosoftCalendarAdapter: manual Graph token exchange/refresh (no `googleapis`-
 * style client library on this side), delta-query incremental sync. See GoogleContactsAdapter's own doc
 * comment for why this never alias-matches into an existing person at import time (PEO-002 "ambiguous
 * merges require review") and why this bypasses IngestionService entirely (no AI classification needed for
 * a contact record).
 */
@Injectable()
export class MicrosoftContactsAdapter implements OAuthConnectorAdapter {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
  ) {}

  isConfigured(): boolean {
    return isConnectorConfigured("microsoft");
  }

  authorizationUrl(params: { redirectUri: string; state: string }): string {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_contacts");
    const env = loadEnv();
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", env.MICROSOFT_OAUTH_CLIENT_ID!);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", params.redirectUri);
    url.searchParams.set("response_mode", "query");
    url.searchParams.set("scope", CONTACTS_SCOPES.join(" "));
    url.searchParams.set("state", params.state);
    return url.toString();
  }

  async handleCallback(params: { code: string; redirectUri: string; ownerUserId: string; householdId: string | null }): Promise<{ connectionId: string }> {
    if (!this.isConfigured()) throw new ConnectorNotConfiguredError("microsoft_contacts");
    const tokens = await this.exchangeCode(params.code, params.redirectUri);

    const connectionId = generateId("connection");
    await this.db.insert(schema.connections).values({
      id: connectionId,
      ownerUserId: params.ownerUserId,
      householdId: params.householdId,
      provider: "microsoft_contacts",
      feasibilityClass: "direct_api",
      scopes: CONTACTS_SCOPES,
      enabledCategories: ["people"],
      health: "initializing",
      historyDepthDays: null,
    });
    const credentialRef = await this.vault.store(connectionId, { access_token: tokens.accessToken, refresh_token: tokens.refreshToken }, tokens.expiresAt);
    await this.db.update(schema.connections).set({ credentialRef }).where(eq(schema.connections.id, connectionId));

    // Synchronous, like GoogleContactsAdapter — see its own doc comment on why this skips the queue.
    await this.initialSync(connectionId);
    return { connectionId };
  }

  private async upsertContact(connection: typeof schema.connections.$inferSelect, connectionId: string, contact: ParsedContact): Promise<boolean> {
    const [existingSource] = await this.db
      .select()
      .from(schema.contactSources)
      .where(
        and(
          eq(schema.contactSources.connectionId, connectionId),
          eq(schema.contactSources.provider, "microsoft"),
          eq(schema.contactSources.providerContactId, contact.providerContactId),
        ),
      )
      .limit(1);

    if (contact.deleted) {
      // See GoogleContactsAdapter.upsertContact's identical doc comment — a deletion signal never destroys
      // the canonical Person row, only stops tracking it as still-synced.
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
        visibility: "private",
      });
      await this.db.insert(schema.contactSources).values({
        id: generateId("contactSource"),
        personId,
        ownerUserId: connection.ownerUserId,
        provider: "microsoft",
        connectionId,
        providerContactId: contact.providerContactId,
        syncedAt: new Date(),
      });
    }

    if (contact.organizationName) {
      const [org] = await this.db
        .select()
        .from(schema.organizations)
        .where(and(eq(schema.organizations.ownerUserId, connection.ownerUserId), eq(schema.organizations.name, contact.organizationName)))
        .limit(1);
      const organizationId = org?.id ?? generateId("organization");
      if (!org) await this.db.insert(schema.organizations).values({ id: organizationId, ownerUserId: connection.ownerUserId, name: contact.organizationName });
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
      const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
      if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");

      let itemCount = 0;
      let url = `${GRAPH_BASE}/me/contacts/delta?$select=${CONTACT_SELECT}`;
      let deltaLink: string | null = null;
      do {
        const page = await this.graphGet<{ value: GraphContact[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
        for (const contact of page.value) {
          const parsed = parseContact(contact);
          if (!parsed) continue;
          if (await this.upsertContact(connection, connectionId, parsed)) itemCount += 1;
        }
        if (page["@odata.deltaLink"]) deltaLink = page["@odata.deltaLink"];
        url = page["@odata.nextLink"] ?? "";
      } while (url);

      await this.db
        .update(schema.connections)
        .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: itemCount, cursor: deltaLink })
        .where(eq(schema.connections.id, connectionId));
      return { itemCount };
    } catch (err) {
      // §43.3 — see GoogleContactsAdapter.initialSync's identical doc comment: microsoft_contacts is also
      // never part of the recurring incremental-scan tick, so nothing else records a failure here.
      await recordConnectorSyncFailure(this.db, connectionId, err, "microsoft");
      throw err;
    }
  }

  /** Same deltaLink-driven incremental sync + 410-Gone-means-full-resync recovery as MicrosoftCalendarAdapter. */
  async incrementalSync(connectionId: string): Promise<{ itemCount: number }> {
    const [connection] = await this.db.select().from(schema.connections).where(eq(schema.connections.id, connectionId)).limit(1);
    if (!connection || !connection.credentialRef) throw new Error("Connection not found or missing credentials");
    if (!connection.cursor) return this.initialSync(connectionId);

    let itemCount = 0;
    let url = connection.cursor;
    let latestDeltaLink = connection.cursor;
    try {
      do {
        const page = await this.graphGet<{ value: GraphContact[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string }>(connection, url);
        for (const contact of page.value) {
          const parsed = parseContact(contact);
          if (!parsed) continue;
          if (await this.upsertContact(connection, connectionId, parsed)) itemCount += 1;
        }
        if (page["@odata.deltaLink"]) latestDeltaLink = page["@odata.deltaLink"];
        url = page["@odata.nextLink"] ?? "";
      } while (url);
    } catch (err) {
      if ((err as { status?: number }).status === 410) return this.initialSync(connectionId);
      await recordConnectorSyncFailure(this.db, connectionId, err, "microsoft");
      throw err;
    }

    await this.db
      .update(schema.connections)
      .set({ health: "healthy", lastSuccessfulSyncAt: new Date(), itemsDiscoveredCount: (connection.itemsDiscoveredCount ?? 0) + itemCount, cursor: latestDeltaLink })
      .where(eq(schema.connections.id, connectionId));
    return { itemCount };
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const env = loadEnv();
    const body = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID!,
      client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET!,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: CONTACTS_SCOPES.join(" "),
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
      scope: CONTACTS_SCOPES.join(" "),
    });
    return this.requestToken(body);
  }

  private async requestToken(body: URLSearchParams): Promise<{ accessToken: string; refreshToken: string; expiresAt: Date }> {
    const response = await fetch(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
    if (!response.ok) throw oauthTokenRequestError("Microsoft", response.status, await response.text());
    const json = (await response.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    return { accessToken: json.access_token, refreshToken: json.refresh_token ?? body.get("refresh_token") ?? "", expiresAt: new Date(Date.now() + json.expires_in * 1000) };
  }

  /** Same transparent-refresh-on-401 shape as MicrosoftCalendarAdapter.graphRequest — kept as its own copy
   * here (rather than a shared helper) since neither adapter's Graph plumbing is public/exported today. */
  private async graphGet<T>(connection: { credentialRef: string | null }, url: string): Promise<T> {
    if (!connection.credentialRef) throw new Error("Connection has no credentialRef");
    const credentials = await this.vault.read(connection.credentialRef);
    if (!credentials) throw new Error("Connection has a credentialRef with no matching vault entry");
    const { access_token, refresh_token } = credentials as unknown as MicrosoftCredentials;

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
