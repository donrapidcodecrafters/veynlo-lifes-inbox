import { BadRequestException, Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import { generateId } from "@veynlo/core";
import type { Database } from "@veynlo/db";
import { schema } from "@veynlo/db";
import { DATABASE } from "../../database/database.module";
import { assertHostnameIsPublic } from "../ingestion/safe-url-fetcher";
import { AttentionService } from "../attention/attention.service";

/**
 * Home Assistant — the Appendix A "Home Assistant" row, and the first §31 smart-home provider that is a
 * real connection rather than an interface waiting for one.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this one is buildable when the other eight are not
 * ---------------------------------------------------------------------------------------------------
 * SmartThings, Nest, Ring, Ecobee, Hue and the Alexa-compatible services each need an OAuth application
 * registered with the vendor, or a partner agreement. That is a business relationship, not a piece of
 * code, and no amount of work here produces one.
 *
 * Home Assistant is self-hosted. The server is the user's, the token is one they generate in their own
 * profile (Profile, Security, Long-Lived Access Tokens), and this deployment holds no client secret and
 * registers nothing. It is the same shape as Canvas, Todoist, Trello and Asana: a credential the user
 * already owns.
 *
 * It also reaches further than any of the gated ones would. Home Assistant already speaks Z-Wave, Zigbee,
 * Matter, Hue, Ecobee, Nest and SmartThings on the local network. A household running it can surface
 * devices here that this codebase could never integrate with directly — through one connector that needs
 * nobody's permission.
 *
 * ---------------------------------------------------------------------------------------------------
 * The part that is a genuine limit, stated rather than hidden
 * ---------------------------------------------------------------------------------------------------
 * Most Home Assistant servers live at a private address — `homeassistant.local:8123`, `192.168.1.40:8123`.
 * This API runs on a server that is not on the user's home network and must never be talked into making
 * requests into private space (`assertHostnameIsPublic` exists for exactly that reason and is not being
 * weakened here).
 *
 * So this connector works for an instance reachable from the internet: Home Assistant Cloud / Nabu Casa
 * (`https://xxxxx.ui.nabu.casa`), or a user's own reverse proxy or DuckDNS name. A LAN-only instance
 * cannot be reached, and `homeAssistantOrigin` says so in those words instead of failing with a generic
 * network error that would send the user hunting for a problem with their token.
 *
 * ---------------------------------------------------------------------------------------------------
 * What is read, and what is deliberately not
 * ---------------------------------------------------------------------------------------------------
 * `GET /api/states` once per sync: entity id, friendly name, state, and a handful of attributes. From
 * those, two things are kept — the devices the user explicitly selected, and health signals worth acting
 * on (a leak, smoke or CO, a flat battery, a fault, a device gone offline, a tamper).
 *
 * Not kept: history, positions, energy readings, camera images, presence, or anything from an entity the
 * user did not select. A home automation server knows when a household is in and out of the house; this
 * connector exists to catch "the basement is wet", not to build a record of anyone's movements.
 *
 * Control is not implemented at all. `SmartHomeAdapter.performControl` stays optional and unimplemented:
 * unlocking a door needs a risk policy designed on purpose, not a method added because the token happens
 * to permit it.
 */

/** One sync's ceiling. A large installation has thousands of entities and this is not the place to hold them all. */
const MAX_ENTITIES = 2000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Below this percentage a battery sensor is worth telling someone about. */
const BATTERY_LOW_PERCENT = 20;

export type HaDeviceType = "lock" | "thermostat" | "camera" | "sensor" | "hub" | "other";

export interface HaDevice {
  providerDeviceId: string;
  label: string;
  deviceType: HaDeviceType;
  room: string | null;
}

export interface HaSignal {
  providerDeviceId: string;
  signalKind: "battery_low" | "fault" | "offline" | "leak" | "smoke_co" | "security";
  severity: "info" | "warning" | "critical";
  detail: string;
  dedupeKey: string;
  occurredAt: Date;
}

/** One entity as `/api/states` returns it, reduced to the fields this connector reads. */
export interface HaEntity {
  entityId: string;
  state: string;
  deviceClass: string | null;
  friendlyName: string | null;
  unit: string | null;
  lastChanged: string | null;
}

/**
 * An address that is obviously on a local network, decided from the STRING ALONE.
 *
 * This deliberately does not do a DNS lookup. `assertHostnameIsPublic` already refuses anything that
 * resolves privately, and it gives the same generic "couldn't reach that" message for a private address as
 * for a dead one — on purpose, so this deployment cannot be used to map out a network by watching which
 * hostnames produce which error.
 *
 * That protection is right and stays. But it makes for a miserable first run: a user types their own
 * server's address, gets "couldn't reach it", and goes looking for a problem with their token. The cases
 * below are decided without asking the network anything, so telling the user precisely what is wrong
 * discloses nothing they did not type in themselves.
 */
export function isObviouslyLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // mDNS — how Home Assistant advertises itself by default, and the single most likely thing to be typed.
  if (host.endsWith(".local") || host.endsWith(".home") || host.endsWith(".lan") || host.endsWith(".internal")) return true;
  if (host === "homeassistant" || host === "hassio") return true;
  if (/^127\./.test(host) || host === "::1") return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  // Carrier-grade NAT and link-local, both of which a home router can hand out.
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  // IPv6 unique-local and link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return false;
}

/**
 * The address a user typed, reduced to an origin this code is willing to call.
 *
 * Returns the origin only, so a pasted `https://x.ui.nabu.casa/lovelace/0?edit=1` cannot smuggle a path
 * or a query into every request this service makes. The port survives, because Home Assistant is
 * overwhelmingly served on 8123 and a user proxying it will have their own.
 */
export function homeAssistantOrigin(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new BadRequestException({ code: "HA_URL_INVALID", message: "Enter the web address of your Home Assistant server." });
  }
  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new BadRequestException({
      code: "HA_URL_INVALID",
      message: "That doesn't look like a web address. Home Assistant Cloud addresses look like https://abc123.ui.nabu.casa.",
    });
  }
  if (isObviouslyLocalHostname(url.hostname)) {
    throw new BadRequestException({
      code: "HA_URL_LOCAL",
      // The full example address (https://abc123.ui.nabu.casa) is deliberately NOT repeated here, even
      // though it reads well on a wide screen. On a phone it wrapped mid-URL — "https://abc123.ui.nabu"
      // on one line and ".casa," on the next — which is hard to read and impossible to copy. The form's
      // placeholder already shows the whole address, so this only has to name where to find it.
      message:
        "That's a home-network address, which Veynlo's servers can't reach from outside your house. " +
        "Use your Home Assistant's remote address instead — the one from Home Assistant Cloud, ending in " +
        ".ui.nabu.casa. Your own reverse proxy or DuckDNS name works too.",
    });
  }
  if (url.protocol !== "https:") {
    throw new BadRequestException({
      code: "HA_URL_INSECURE",
      message: "The address has to start with https — your access token would be sent in the clear otherwise.",
    });
  }
  return url.origin;
}

/**
 * Which kind of thing an entity is, from the part of its id before the dot.
 *
 * Home Assistant calls that the domain, and it is the only reliable classifier `/api/states` carries —
 * there is no device-type field. `climate` covers thermostats and `water_heater` behaves like one for the
 * purpose of "something in this house controls a temperature".
 */
export function haDeviceType(entityId: string): HaDeviceType {
  const domain = entityId.split(".")[0] ?? "";
  switch (domain) {
    case "lock":
      return "lock";
    case "climate":
    case "water_heater":
      return "thermostat";
    case "camera":
      return "camera";
    case "binary_sensor":
    case "sensor":
      return "sensor";
    default:
      return "other";
  }
}

/** The domains this connector will offer at all. Everything else is noise for a household's purposes. */
const OFFERED_DOMAINS = new Set(["lock", "climate", "water_heater", "camera", "binary_sensor", "sensor"]);

/**
 * Among sensors, the device classes that can indicate something is wrong or that a person would recognise.
 *
 * A real installation has hundreds of diagnostic entities — uptime counters, signal strengths, firmware
 * version strings — and offering all of them turns device selection into a chore nobody finishes.
 */
const MEANINGFUL_SENSOR_CLASSES = new Set([
  "battery",
  "moisture",
  "smoke",
  "gas",
  "carbon_monoxide",
  "problem",
  "safety",
  "tamper",
  "temperature",
  "humidity",
  "door",
  "window",
  "lock",
]);

/** Whether an entity is worth showing a person in a picker. */
export function isOfferedEntity(entity: { entityId: string; deviceClass: string | null }): boolean {
  const domain = entity.entityId.split(".")[0] ?? "";
  if (!OFFERED_DOMAINS.has(domain)) return false;
  if (domain === "sensor" || domain === "binary_sensor") {
    return entity.deviceClass !== null && MEANINGFUL_SENSOR_CLASSES.has(entity.deviceClass);
  }
  return true;
}

/** `/api/states` as Home Assistant returns it, reduced to what is read. Anything malformed is skipped. */
export function parseHomeAssistantStates(payload: unknown): HaEntity[] {
  if (!Array.isArray(payload)) return [];
  const out: HaEntity[] = [];
  for (const raw of payload.slice(0, MAX_ENTITIES)) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const entityId = typeof e.entity_id === "string" ? e.entity_id : "";
    // An entity id is always "domain.object_id". Anything else did not come from Home Assistant.
    if (!entityId || !entityId.includes(".")) continue;
    const attrs = (e.attributes && typeof e.attributes === "object" ? e.attributes : {}) as Record<string, unknown>;
    out.push({
      entityId,
      state: typeof e.state === "string" ? e.state : "",
      deviceClass: typeof attrs.device_class === "string" ? attrs.device_class : null,
      friendlyName: typeof attrs.friendly_name === "string" ? attrs.friendly_name.trim() || null : null,
      unit: typeof attrs.unit_of_measurement === "string" ? attrs.unit_of_measurement : null,
      lastChanged: typeof e.last_changed === "string" ? e.last_changed : null,
    });
  }
  return out;
}

/** The devices a user can choose from, in the order Home Assistant gave them. */
export function homeAssistantDevices(entities: HaEntity[]): HaDevice[] {
  const out: HaDevice[] = [];
  for (const entity of entities) {
    if (!isOfferedEntity(entity)) continue;
    out.push({
      providerDeviceId: entity.entityId,
      // The friendly name is what the user called it in their own house. Falling back to the entity id is
      // ugly but always true, which beats inventing a title.
      label: (entity.friendlyName ?? entity.entityId).slice(0, 200),
      deviceType: haDeviceType(entity.entityId),
      // Home Assistant's area assignments are not in `/api/states` — reading them needs the websocket API
      // or a rendered template, and neither is worth a second transport here. Most users put the room in
      // the friendly name anyway ("Basement Water Sensor"), so this loses little.
      room: null,
    });
  }
  return out;
}

/** Binary device classes that mean something is wrong when the state is "on". */
const BINARY_SIGNALS: Record<string, { kind: HaSignal["signalKind"]; severity: HaSignal["severity"]; detail: string }> = {
  smoke: { kind: "smoke_co", severity: "critical", detail: "smoke detected" },
  gas: { kind: "smoke_co", severity: "critical", detail: "gas detected" },
  carbon_monoxide: { kind: "smoke_co", severity: "critical", detail: "carbon monoxide detected" },
  moisture: { kind: "leak", severity: "critical", detail: "water detected" },
  safety: { kind: "fault", severity: "critical", detail: "reporting unsafe" },
  problem: { kind: "fault", severity: "warning", detail: "reporting a problem" },
  battery: { kind: "battery_low", severity: "warning", detail: "battery low" },
  tamper: { kind: "security", severity: "warning", detail: "tampering detected" },
};

/**
 * What is worth telling a household about, from one entity's current state.
 *
 * Returns at most one signal. The dedupe key is what stops a leak that stays wet from filing the same
 * obligation on every sync:
 *
 *   binary signals   keyed on `last_changed`, so one key per time the thing actually turned on. A sensor
 *                    that has been wet for a day files once, and a second, separate leak files again.
 *
 *   battery level    keyed on a ten-percent band rather than `last_changed`, because a reading ticking
 *                    19 → 18 → 17 changes `last_changed` every time and would file three obligations for
 *                    one flat battery. The cost of the band is real and worth stating: a battery replaced
 *                    and then drained back into the same band does not file again.
 */
export function homeAssistantSignal(entity: HaEntity): HaSignal | null {
  const parsed = entity.lastChanged ? new Date(entity.lastChanged) : new Date();
  const when = Number.isNaN(parsed.getTime()) ? new Date() : parsed;
  const name = entity.friendlyName ?? entity.entityId;

  // "unavailable" means Home Assistant cannot reach the device. "unknown" does not — it is the normal
  // state of an entity that has not reported since a restart, and treating it as offline would file a
  // false alarm every time the user reboots their server.
  if (entity.state === "unavailable") {
    return {
      providerDeviceId: entity.entityId,
      signalKind: "offline",
      severity: "warning",
      detail: `${name} is not responding`,
      dedupeKey: `${entity.entityId}:offline:${entity.lastChanged ?? ""}`,
      occurredAt: when,
    };
  }

  const domain = entity.entityId.split(".")[0] ?? "";

  if (domain === "binary_sensor" && entity.state === "on" && entity.deviceClass) {
    const mapped = BINARY_SIGNALS[entity.deviceClass];
    if (mapped) {
      return {
        providerDeviceId: entity.entityId,
        signalKind: mapped.kind,
        severity: mapped.severity,
        detail: `${name}: ${mapped.detail}`,
        dedupeKey: `${entity.entityId}:${mapped.kind}:${entity.lastChanged ?? ""}`,
        occurredAt: when,
      };
    }
  }

  if (domain === "sensor" && entity.deviceClass === "battery") {
    // `Number("")` is 0, not NaN — so a battery entity reporting nothing at all would otherwise be filed
    // as "battery at 0%", an urgent-looking alarm invented out of no data. The state has to actually look
    // like a number before it is read as one.
    const percent = /^-?\d+(\.\d+)?$/.test(entity.state.trim()) ? Number(entity.state) : Number.NaN;
    if (Number.isFinite(percent) && percent >= 0 && percent < BATTERY_LOW_PERCENT) {
      const band = Math.floor(percent / 10) * 10;
      return {
        providerDeviceId: entity.entityId,
        signalKind: "battery_low",
        severity: percent < 10 ? "warning" : "info",
        detail: `${name}: battery at ${Math.round(percent)}%`,
        dedupeKey: `${entity.entityId}:battery_low:band${band}`,
        occurredAt: when,
      };
    }
  }

  return null;
}

/**
 * How loudly a device's own severity should be raised to the household.
 *
 * Deliberately not a pass-through of the strings: `AttentionService` has three urgencies and this has
 * three severities, and they do not mean the same things. "info" here is a battery at 15% — worth knowing,
 * not worth interrupting anyone for.
 */
const SIGNAL_URGENCY: Record<HaSignal["severity"], "critical" | "important" | "useful"> = {
  critical: "critical",
  warning: "important",
  info: "useful",
};

@Injectable()
export class HomeAssistantService {
  private readonly logger = new Logger(HomeAssistantService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    @Inject(AttentionService) private readonly attention: AttentionService,
  ) {}

  /**
   * The SSRF check, as its own method so a test can reach a local server without the guard being weakened
   * for anything else — the same seam, for the same reason, as `CanvasService.assertHostAllowed`.
   *
   * A subclass in the test file overrides this one method and nothing else. The production class still
   * calls the real guard on every request, and the refusals have their own tests against it directly.
   */
  protected async assertHostAllowed(hostname: string): Promise<void> {
    await assertHostnameIsPublic(hostname);
  }

  /**
   * The address check, as its own method for the same reason as `assertHostAllowed` above.
   *
   * `homeAssistantOrigin` refuses a loopback address from the STRING, before any request is made — which
   * is the right order for production (nothing should be sent to an address this code has already decided
   * not to call) and the reason a test server on 127.0.0.1 cannot be reached through `probe` otherwise.
   *
   * Overridden in the test file for 127.0.0.1 alone. The rule itself is exercised against the unmodified
   * service, which is what must not be able to make those refusals pass.
   */
  protected originFor(baseUrl: string): string {
    return homeAssistantOrigin(baseUrl);
  }

  private async request(origin: string, path: string, token: string): Promise<unknown> {
    // Re-checked on every call rather than only at connect: a hostname accepted last week can point at an
    // internal address today, and this one is a user-supplied address by definition.
    await this.assertHostAllowed(new URL(origin).hostname);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${origin}${path}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
        signal: controller.signal,
        // A redirect could leave this deployment following a Location header somewhere the guard above
        // never saw — with the user's token attached.
        redirect: "manual",
      });
      if (response.status === 401 || response.status === 403) {
        throw new BadRequestException({
          code: "HA_TOKEN_REJECTED",
          message: "Home Assistant rejected that token. Create a new one under Profile, Security, Long-Lived Access Tokens.",
        });
      }
      if (!response.ok) throw new Error(`home assistant responded ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Verify the address and token by using them, before any row is written.
   *
   * `GET /api/` is Home Assistant's own liveness endpoint and answers `{"message": "API running."}` for a
   * valid token. A connection created from an unverified token sits in the list looking healthy and
   * producing nothing.
   */
  async probe(baseUrl: string, token: string): Promise<{ origin: string }> {
    const origin = this.originFor(baseUrl);
    try {
      const body = (await this.request(origin, "/api/", token)) as { message?: unknown };
      if (typeof body?.message !== "string" || !body.message.toLowerCase().includes("api running")) {
        // Something answered on that address and it was not Home Assistant — a router's admin page, a
        // parked domain, someone else's server. Saying "rejected your token" would be wrong and would
        // send the user off to generate another one for no reason.
        throw new BadRequestException({
          code: "HA_NOT_HOME_ASSISTANT",
          message: "Something answered at that address, but it wasn't Home Assistant. Check the address and try again.",
        });
      }
      return { origin };
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Never echo the provider's raw error — it can carry the request URL, and the token with it.
      this.logger.warn(`home assistant probe failed: ${(err as Error)?.name ?? "error"}`);
      throw new BadRequestException({
        code: "HA_UNREACHABLE",
        message: "Couldn't reach Home Assistant at that address. Check it's the remote address and that it's online.",
      });
    }
  }

  /** Everything this connector reads, in one request, so the callers below are only filing. */
  async fetchEntities(origin: string, token: string): Promise<HaEntity[]> {
    return parseHomeAssistantStates(await this.request(origin, "/api/states", token));
  }

  private async loadConnection(
    smartConnectionId: string,
  ): Promise<{ apiBaseUrl: string; apiToken: string; ownerUserId: string; propertyProfileId: string | null; householdId: string | null } | null> {
    const [row] = await this.db
      .select()
      .from(schema.smartConnections)
      .where(eq(schema.smartConnections.id, smartConnectionId))
      .limit(1);
    if (!row || row.provider !== "home_assistant" || !row.apiBaseUrl || !row.apiToken || row.disconnectedAt) return null;
    return {
      apiBaseUrl: row.apiBaseUrl,
      apiToken: row.apiToken,
      ownerUserId: row.ownerUserId,
      propertyProfileId: row.propertyProfileId,
      householdId: row.householdId,
    };
  }

  /**
   * SMART-001 "Connection settings show exactly which device types/signals are imported" — what the user's
   * server offers, so they can pick. Nothing is imported until something is selected.
   */
  async listAvailableDevices(smartConnectionId: string): Promise<HaDevice[]> {
    const connection = await this.loadConnection(smartConnectionId);
    if (!connection) return [];
    return homeAssistantDevices(await this.fetchEntities(connection.apiBaseUrl, connection.apiToken));
  }

  /**
   * Read the selected devices' current state and file anything worth acting on.
   *
   * Only devices the user selected are read for signals. An unselected entity is still listed by
   * `listAvailableDevices` — that is how it gets selected in the first place — but never produces a row.
   */
  async sync(smartConnectionId: string): Promise<{ deviceCount: number; signalCount: number }> {
    const connection = await this.loadConnection(smartConnectionId);
    if (!connection) return { deviceCount: 0, signalCount: 0 };

    let entities: HaEntity[];
    try {
      entities = await this.fetchEntities(connection.apiBaseUrl, connection.apiToken);
    } catch (err) {
      // Which failure this was decides what the household is told, and telling them the wrong one is not a
      // cosmetic mistake: "your token was rejected" sends someone to Home Assistant to make a new one, and
      // if the real problem is that their address stopped resolving, the new token will not help either.
      //
      // Chosen on the error CODE, not the exception class — `BadRequestException` is also what the SSRF
      // guard throws, so an address repointed at a private range would otherwise be reported as a revoked
      // token. That exact mistake was made once in CanvasService and is deliberately not repeated here.
      const response = (err as { getResponse?: () => unknown })?.getResponse?.();
      const code = response && typeof response === "object" && "code" in response ? String((response as { code: unknown }).code) : "";
      const healthDetail =
        code === "HA_TOKEN_REJECTED"
          ? "Home Assistant rejected the saved token. Long-Lived Access Tokens can be revoked from your profile — create a new one and reconnect."
          : code === "URL_UNREACHABLE" || code === "HA_URL_LOCAL" || code === "HA_URL_INSECURE" || code === "HA_URL_INVALID"
            ? "That Home Assistant address can no longer be reached safely. Check the remote address is still correct and reconnect."
            : "Couldn't reach Home Assistant on the last sync.";
      await this.db
        .update(schema.smartConnections)
        .set({ status: "error", healthDetail, updatedAt: new Date() })
        .where(eq(schema.smartConnections.id, smartConnectionId));
      throw err;
    }

    const byEntityId = new Map(entities.map((e) => [e.entityId, e]));

    const selected = await this.db
      .select()
      .from(schema.smartDevices)
      .where(and(eq(schema.smartDevices.smartConnectionId, smartConnectionId), eq(schema.smartDevices.isSelected, true)));

    let signalCount = 0;
    for (const device of selected) {
      const entity = byEntityId.get(device.providerDeviceId);
      if (!entity) continue;
      const signal = homeAssistantSignal(entity);
      if (!signal) continue;

      // The dedupe index is on (ownerUserId, dedupeKey); checked here rather than relied on as a
      // constraint, because there is no unique index there and adding one would change a shared table's
      // shape for one connector's benefit.
      const [existing] = await this.db
        .select({ id: schema.deviceSignals.id })
        .from(schema.deviceSignals)
        .where(and(eq(schema.deviceSignals.ownerUserId, device.ownerUserId), eq(schema.deviceSignals.dedupeKey, signal.dedupeKey)))
        .limit(1);
      if (existing) continue;

      /**
       * A signal nobody is told about is not a feature.
       *
       * Writing a `device_signals` row and stopping there is precisely the failure this codebase keeps
       * finding: the capture succeeds, nothing errors, and the household is never informed. A leak sensor
       * earns its place by somebody hearing about the leak.
       *
       * SMART-002 "Maintenance/health signals into obligations" — filed through the same
       * `AttentionService.fileIfNew` every other scanner in this app uses, rather than a second parallel
       * "insert an attention item" path with its own dedup bugs to find later. Keyed on the signal's own
       * id, so a SECOND leak files a second obligation while the same continuing one does not — the
       * dedupe that decides that already happened above, on `dedupeKey`.
       */
      const deviceSignalId = generateId("deviceSignal");
      await this.db.insert(schema.deviceSignals).values({
        id: deviceSignalId,
        smartDeviceId: device.id,
        ownerUserId: device.ownerUserId,
        signalKind: signal.signalKind,
        severity: signal.severity,
        detail: signal.detail,
        dedupeKey: signal.dedupeKey,
        occurredAt: signal.occurredAt,
      });

      try {
        await this.attention.fileIfNew({
          ownerUserId: device.ownerUserId,
          householdId: connection.householdId,
          reasonCode: `smart_home_${signal.signalKind}`,
          reasonText: signal.detail,
          urgency: SIGNAL_URGENCY[signal.severity],
          // A leak is happening now. There is no future deadline to count down to, and inventing one would
          // put a smoke alarm behind something due next week.
          dueAt: null,
          dueAtSort: signal.occurredAt,
          moneyAtStakeMinorUnits: null,
          moneyAtStakeCurrency: null,
          // The device said so. Nothing here was inferred from prose or guessed by a model.
          confidenceBand: "verified",
          linkedResourceType: "device_signal",
          linkedResourceId: deviceSignalId,
          primaryActions: ["view_device", "dismiss"],
        });
        await this.db.update(schema.deviceSignals).set({ attentionItemId: deviceSignalId }).where(eq(schema.deviceSignals.id, deviceSignalId));
      } catch (err) {
        // The signal itself is already recorded. Losing the whole sync because one obligation could not be
        // filed would also lose every other device's reading in the same pass.
        this.logger.warn(`Filed a device signal but could not raise it for attention: ${(err as Error)?.name ?? "error"}`);
      }

      signalCount += 1;
    }

    await this.db
      .update(schema.smartConnections)
      .set({ status: "connected", healthDetail: null, lastSuccessfulSyncAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.smartConnections.id, smartConnectionId));

    return { deviceCount: selected.length, signalCount };
  }

  /**
   * Replace the set of selected devices.
   *
   * Devices arriving for the first time are inserted; ones already known have their selection updated;
   * ones the user deselected are marked unselected rather than deleted, so the signals already filed
   * against them keep their device row instead of becoming orphans pointing at nothing.
   */
  async setSelectedDevices(smartConnectionId: string, providerDeviceIds: string[]): Promise<{ selectedCount: number }> {
    const connection = await this.loadConnection(smartConnectionId);
    if (!connection) {
      throw new BadRequestException({ code: "HA_NOT_CONNECTED", message: "That Home Assistant connection is no longer active." });
    }

    const wanted = new Set(providerDeviceIds);
    const available = homeAssistantDevices(await this.fetchEntities(connection.apiBaseUrl, connection.apiToken));
    const availableById = new Map(available.map((d) => [d.providerDeviceId, d]));

    // An id the server does not offer is refused rather than stored: it would create a device row that can
    // never match an entity and therefore can never produce a signal — a selection that silently does
    // nothing, which on screen looks identical to one that works.
    for (const id of wanted) {
      if (!availableById.has(id)) {
        throw new BadRequestException({
          code: "HA_DEVICE_UNKNOWN",
          message: "One of those devices isn't offered by that Home Assistant any more.",
        });
      }
    }

    const existing = await this.db
      .select()
      .from(schema.smartDevices)
      .where(eq(schema.smartDevices.smartConnectionId, smartConnectionId));
    const existingById = new Map(existing.map((d) => [d.providerDeviceId, d]));

    for (const id of wanted) {
      const device = availableById.get(id);
      if (!device) continue;
      const already = existingById.get(id);
      if (already) {
        await this.db
          .update(schema.smartDevices)
          .set({ isSelected: true, label: device.label, deviceType: device.deviceType, updatedAt: new Date() })
          .where(eq(schema.smartDevices.id, already.id));
      } else {
        await this.db.insert(schema.smartDevices).values({
          id: generateId("smartDevice"),
          smartConnectionId,
          ownerUserId: connection.ownerUserId,
          propertyProfileId: connection.propertyProfileId,
          providerDeviceId: device.providerDeviceId,
          label: device.label,
          deviceType: device.deviceType,
          room: device.room,
          isSelected: true,
        });
      }
    }

    const toDeselect = existing.filter((d) => d.isSelected && !wanted.has(d.providerDeviceId)).map((d) => d.id);
    if (toDeselect.length > 0) {
      await this.db
        .update(schema.smartDevices)
        .set({ isSelected: false, updatedAt: new Date() })
        .where(inArray(schema.smartDevices.id, toDeselect));
    }

    return { selectedCount: wanted.size };
  }
}
