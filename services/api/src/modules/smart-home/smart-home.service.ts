import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { HomeAssistantService } from "./home-assistant.service";
import type { ConnectHomeAssistantDto } from "./dto";

/**
 * Every provider the recurring scan polls.
 *
 * This exists so that "a user can connect it" and "it is actually kept up to date" cannot drift apart.
 * They did drift apart once, for three connectors at the same time: `imap`, `caldav` and `carddav` were
 * connectable, synced once on connect, and were then never scheduled again — sitting healthy and
 * completely silent for thirteen days before anyone measured it.
 *
 * For a smart-home connector that failure is worse than for a mailbox. The entire value of a leak sensor
 * is that something notices while nobody is looking; a connection that only syncs when its screen is open
 * is a connection that will never once tell a household anything they did not already know.
 *
 * `assertSmartHomeProvidersAreSyncable` below is the check, run against the DTO's accepted providers.
 */
export const SYNCABLE_SMART_HOME_PROVIDERS = ["home_assistant"] as const;
export type SyncableSmartHomeProvider = (typeof SYNCABLE_SMART_HOME_PROVIDERS)[number];

/**
 * Refuse a provider that can be connected but would never be polled, or polled but never connectable.
 *
 * Called from the module's own test rather than at boot: unlike the connector registry, which is built
 * from adapters resolved at runtime, both lists here are static, so the drift is visible the moment the
 * suite runs and does not need to wait for a deploy.
 */
export function assertSmartHomeProvidersAreSyncable(connectableProviders: readonly string[]): void {
  const connectable = [...connectableProviders].sort();
  const scanned = [...SYNCABLE_SMART_HOME_PROVIDERS].sort();
  const neverPolled = connectable.filter((p) => !scanned.includes(p as SyncableSmartHomeProvider));
  const neverConnectable = scanned.filter((p) => !connectable.includes(p));
  if (neverPolled.length === 0 && neverConnectable.length === 0) return;
  const parts: string[] = [];
  if (neverPolled.length > 0) {
    parts.push(`connectable but never polled (would sync once and then go silent): ${neverPolled.join(", ")}`);
  }
  if (neverConnectable.length > 0) {
    parts.push(`polled but not connectable (the scan enqueues work nothing can do): ${neverConnectable.join(", ")}`);
  }
  throw new Error(`Smart-home provider registration has drifted — ${parts.join("; ")}.`);
}

/**
 * Owning, listing and disconnecting smart-home connections — everything that is true of any provider,
 * kept apart from `HomeAssistantService`, which knows what a Home Assistant entity is.
 *
 * That split is the same one `ConnectorsService` and the per-provider adapters already make, and it is
 * what lets a second provider (if one ever stops being partnership-gated) arrive as a new adapter rather
 * than as edits scattered through this file.
 */
@Injectable()
export class SmartHomeService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(HomeAssistantService) private readonly homeAssistant: HomeAssistantService,
  ) {}

  /**
   * Every connection this user owns, with enough to render a card and nothing more.
   *
   * Two layers, and it is worth being precise about which one does the work, because falsification
   * showed the obvious answer was wrong.
   *
   * The MAPPING below is what actually keeps `apiToken` out of the response: it names every field that
   * leaves this method, so a column added to the table later cannot ride along. Swapping the explicit
   * column list for a bare `select()` changes nothing observable while that mapping stands — proven by
   * breaking it and watching the suite stay green.
   *
   * The explicit column list is still here, as defence in depth and because the token has no business
   * being read out of the database at all on a route that will never use it. But the test pins the
   * mapping's exact key set, not the select, since that is the thing standing between a user's
   * Long-Lived Access Token and every caller of this route.
   *
   * `listSchoolSources` had exactly this defect for real — a bare `select()` with no mapping handed a
   * Canvas token and an ICS URL to every household member and delegate. One occurrence is enough.
   */
  async listConnections(userId: string) {
    const rows = await this.db
      .select({
        id: schema.smartConnections.id,
        provider: schema.smartConnections.provider,
        status: schema.smartConnections.status,
        healthDetail: schema.smartConnections.healthDetail,
        apiBaseUrl: schema.smartConnections.apiBaseUrl,
        lastSuccessfulSyncAt: schema.smartConnections.lastSuccessfulSyncAt,
        createdAt: schema.smartConnections.createdAt,
        disconnectedAt: schema.smartConnections.disconnectedAt,
      })
      .from(schema.smartConnections)
      .where(eq(schema.smartConnections.ownerUserId, userId))
      .orderBy(desc(schema.smartConnections.createdAt));

    const active = rows.filter((row) => row.disconnectedAt === null);
    if (active.length === 0) return [];

    const devices = await this.db
      .select({
        id: schema.smartDevices.id,
        smartConnectionId: schema.smartDevices.smartConnectionId,
        label: schema.smartDevices.label,
        deviceType: schema.smartDevices.deviceType,
        isSelected: schema.smartDevices.isSelected,
      })
      .from(schema.smartDevices)
      .where(
        inArray(
          schema.smartDevices.smartConnectionId,
          active.map((row) => row.id),
        ),
      );

    return active.map((row) => ({
      id: row.id,
      provider: row.provider,
      status: row.status,
      healthDetail: row.healthDetail,
      // The address is shown back so a user with two homes can tell which connection is which. The token
      // is not, and is not selected above.
      baseUrl: row.apiBaseUrl,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      createdAt: row.createdAt,
      selectedDevices: devices
        .filter((d) => d.smartConnectionId === row.id && d.isSelected)
        .map((d) => ({ id: d.id, label: d.label, deviceType: d.deviceType })),
    }));
  }

  /** Throws unless this user owns this connection and it is still active. */
  private async requireOwned(connectionId: string, userId: string) {
    const [row] = await this.db
      .select()
      .from(schema.smartConnections)
      .where(eq(schema.smartConnections.id, connectionId))
      .limit(1);
    if (!row) throw new NotFoundException({ code: "SMART_CONNECTION_NOT_FOUND", message: "That connection doesn't exist." });
    // Checked separately from existence but reported the same way, so this route cannot be used to
    // discover whether an id belongs to somebody else.
    if (row.ownerUserId !== userId) {
      throw new NotFoundException({ code: "SMART_CONNECTION_NOT_FOUND", message: "That connection doesn't exist." });
    }
    if (row.disconnectedAt) {
      throw new BadRequestException({ code: "SMART_CONNECTION_DISCONNECTED", message: "That connection has been disconnected." });
    }
    return row;
  }

  /**
   * Connect a Home Assistant.
   *
   * The address and token are proved to work BEFORE any row is written — same "fail loud on connect, not
   * on the next silent poll" reasoning as the ICS and Canvas sources. A connection created from an
   * unverified token sits in the list looking healthy and producing nothing, which is worse than a
   * refusal because nobody goes looking for it.
   */
  async connectHomeAssistant(userId: string, dto: ConnectHomeAssistantDto): Promise<{ id: string }> {
    const { origin } = await this.homeAssistant.probe(dto.baseUrl, dto.token);

    if (dto.propertyProfileId) {
      const [property] = await this.db
        .select({ id: schema.propertyProfiles.id, ownerUserId: schema.propertyProfiles.ownerUserId })
        .from(schema.propertyProfiles)
        .where(eq(schema.propertyProfiles.id, dto.propertyProfileId))
        .limit(1);
      if (!property || property.ownerUserId !== userId) {
        throw new ForbiddenException({ code: "PROPERTY_NOT_YOURS", message: "That property isn't yours." });
      }
    }

    const id = generateId("smartConnection");
    await this.db.insert(schema.smartConnections).values({
      id,
      ownerUserId: userId,
      householdId: null,
      propertyProfileId: dto.propertyProfileId ?? null,
      provider: "home_assistant",
      // Reaches "connected" because it genuinely is: the address and token were just used successfully.
      status: "connected",
      // The verified origin, not the raw string the user typed — so whatever is polled later is what was
      // actually checked, rather than something that merely resembles it.
      apiBaseUrl: origin,
      apiToken: dto.token,
    });
    return { id };
  }

  /** What the user's server offers, so they can choose. Nothing is imported until something is selected. */
  async listAvailableDevices(connectionId: string, userId: string) {
    await this.requireOwned(connectionId, userId);
    const available = await this.homeAssistant.listAvailableDevices(connectionId);
    const selected = await this.db
      .select({ providerDeviceId: schema.smartDevices.providerDeviceId, isSelected: schema.smartDevices.isSelected })
      .from(schema.smartDevices)
      .where(eq(schema.smartDevices.smartConnectionId, connectionId));
    const selectedIds = new Set(selected.filter((d) => d.isSelected).map((d) => d.providerDeviceId));
    return available.map((device) => ({ ...device, isSelected: selectedIds.has(device.providerDeviceId) }));
  }

  async setSelectedDevices(connectionId: string, userId: string, providerDeviceIds: string[]) {
    await this.requireOwned(connectionId, userId);
    return this.homeAssistant.setSelectedDevices(connectionId, providerDeviceIds);
  }

  async sync(connectionId: string, userId: string) {
    await this.requireOwned(connectionId, userId);
    return this.homeAssistant.sync(connectionId);
  }

  /**
   * Disconnect, and destroy the credential in the same statement.
   *
   * The token is nulled rather than left behind. A disconnected connection that still holds a working
   * Long-Lived Access Token is a credential this deployment is storing for no reason and with no screen
   * that would ever show it again — which is the definition of something that should not still be there.
   *
   * Device rows and their signals are kept: they are the household's own history of what was reported,
   * and deleting that on disconnect would quietly erase a record of a leak or a smoke alarm.
   */
  async disconnect(connectionId: string, userId: string): Promise<{ disconnected: true }> {
    await this.requireOwned(connectionId, userId);
    await this.db
      .update(schema.smartConnections)
      .set({
        status: "not_configured",
        apiToken: null,
        healthDetail: null,
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.smartConnections.id, connectionId), eq(schema.smartConnections.ownerUserId, userId)));
    await this.db
      .update(schema.smartDevices)
      .set({ isSelected: false, updatedAt: new Date() })
      .where(eq(schema.smartDevices.smartConnectionId, connectionId));
    return { disconnected: true };
  }

  /** The signals filed against this user's selected devices, newest first. */
  async listSignals(userId: string, limit = 50) {
    return this.db
      .select({
        id: schema.deviceSignals.id,
        signalKind: schema.deviceSignals.signalKind,
        severity: schema.deviceSignals.severity,
        detail: schema.deviceSignals.detail,
        occurredAt: schema.deviceSignals.occurredAt,
        deviceLabel: schema.smartDevices.label,
      })
      .from(schema.deviceSignals)
      .innerJoin(schema.smartDevices, eq(schema.deviceSignals.smartDeviceId, schema.smartDevices.id))
      .where(eq(schema.deviceSignals.ownerUserId, userId))
      .orderBy(desc(schema.deviceSignals.occurredAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }
}
