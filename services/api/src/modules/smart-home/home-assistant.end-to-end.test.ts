import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { and, desc, eq } from "drizzle-orm";
import { createDbClient, schema, type Database } from "@veynlo/db";
import { generateId } from "@veynlo/core";
import { HomeAssistantService } from "./home-assistant.service";
import { SmartHomeService } from "./smart-home.service";
import type { AttentionService } from "../attention/attention.service";
import { skipIfDatabaseUnreachable } from "../../test-support/db-availability";

/**
 * A wet basement, all the way to a row a household can see.
 *
 * `home-assistant.service.test.ts` proves the normalizers and the dedupe keys. Neither proves the join,
 * which is where a connector usually fails in practice: the data is fetched correctly and then lands
 * nowhere, or lands twice, or lands against the wrong device.
 *
 * So this runs the real sync against a real HTTPS server and a real database, and reads `device_signals`
 * back. It speaks real TLS for the same reason the Canvas suite does — the https rule is not something to
 * bypass for a test, because proving the token travels safely means actually putting it through TLS:
 *
 *   NODE_EXTRA_CA_CERTS=<repo>/.claude/test-certs/localhost-cert.pem npx vitest run src/modules/smart-home/home-assistant.end-to-end.test.ts
 *
 * Two things are overridden, both only for 127.0.0.1: the DNS-level host guard, and the string-level
 * address rule that refuses a loopback address before any request is made. Both refusals are asserted
 * against the UNMODIFIED service below — which is precisely what the subclass must not be able to make
 * pass, and the reason that test constructs its own instance rather than reusing this one.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://veynlo:veynlo_dev_password@localhost:5433/veynlo";

/**
 * Every hostname the guard was asked about, in order.
 *
 * The guard's own refusals live in `safe-url-fetcher.test.ts`. What THIS service has to guarantee is
 * different and is its own to get wrong: that the guard is consulted on every single request, not just at
 * connect. Recording the calls is how deleting that line becomes visible — asserting on a refusal cannot
 * see it, because the addresses used here are already refused by the string rule one layer earlier.
 */
const guardCalls: string[] = [];

/** Reaches the local test server, and changes nothing else. */
class LocalHomeAssistantService extends HomeAssistantService {
  protected override async assertHostAllowed(hostname: string): Promise<void> {
    guardCalls.push(hostname);
    if (hostname === "127.0.0.1") return;
    return super.assertHostAllowed(hostname);
  }

  /**
   * The address rule refuses a loopback address from the string, before any request is made — correct for
   * production, and the reason a test server on 127.0.0.1 is unreachable through `probe` without this.
   * Loopback only; every other address goes through the real rule.
   */
  protected override originFor(baseUrl: string): string {
    const url = new URL(baseUrl);
    if (url.hostname === "127.0.0.1") return url.origin;
    return super.originFor(baseUrl);
  }
}

let server: https.Server;
let origin: string;
const seen: { path: string; auth: string | undefined }[] = [];

/** Flipped mid-test to change what the house is reporting. */
let basementWet = true;
/** When the sensor last changed state — what the dedupe key is built from. */
let basementChangedAt = "2026-09-21T03:00:00+00:00";
let lockBatteryPercent = "84";
let tokenRejected = false;
/** Flipped to prove an address that stops being Home Assistant is reported as such. */
let apiRunning = true;

function states() {
  return [
    {
      entity_id: "binary_sensor.basement_water",
      state: basementWet ? "on" : "off",
      attributes: { device_class: "moisture", friendly_name: "Basement Water Sensor" },
      last_changed: basementChangedAt,
    },
    {
      entity_id: "sensor.front_door_lock_battery",
      state: lockBatteryPercent,
      attributes: { device_class: "battery", friendly_name: "Front Door Lock Battery", unit_of_measurement: "%" },
      last_changed: "2026-09-20T12:00:00+00:00",
    },
    {
      entity_id: "lock.front_door",
      state: "locked",
      attributes: { friendly_name: "Front Door" },
      last_changed: "2026-09-19T08:00:00+00:00",
    },
    // Diagnostic clutter: a real installation is full of it, and none of it should be offered.
    {
      entity_id: "sensor.wifi_signal_strength",
      state: "-52",
      attributes: { device_class: "signal_strength", friendly_name: "WiFi Signal" },
      last_changed: "2026-09-21T03:59:00+00:00",
    },
    { entity_id: "automation.morning_lights", state: "on", attributes: { friendly_name: "Morning Lights" } },
    { entity_id: "light.hallway", state: "on", attributes: { friendly_name: "Hallway" } },
  ];
}

describe("a wet basement becomes a device signal", () => {
  let db: Database;
  let homeAssistant: LocalHomeAssistantService;
  let smartHome: SmartHomeService;
  let realService: HomeAssistantService;
  let filedAttention: Record<string, unknown>[];
  let ownerUserId: string;
  let connectionId: string;
  let dbAvailable = true;

  beforeAll(async () => {
    const certDir = path.join(__dirname, "..", "..", "..", "..", "..", ".claude", "test-certs");
    server = https.createServer(
      { key: fs.readFileSync(path.join(certDir, "localhost-key.pem")), cert: fs.readFileSync(path.join(certDir, "localhost-cert.pem")) },
      (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        seen.push({ path: `${url.pathname}${url.search}`, auth: req.headers.authorization });
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        };
        if (tokenRejected) return json(401, { message: "Unauthorized" });
        if (url.pathname === "/api/") {
          return json(200, apiRunning ? { message: "API running." } : { ok: true, service: "something else entirely" });
        }
        if (url.pathname === "/api/states") return json(200, states());
        return json(404, {});
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

    db = createDbClient(DATABASE_URL);
    try {
      // Records every obligation raised, so "the household was told" is checkable rather than assumed.
      // Writing a device_signals row and stopping there is the failure this whole connector exists to
      // avoid: the capture succeeds, nothing errors, and nobody hears about the leak.
      filedAttention = [];
      const attention = {
        fileIfNew: async (item: Record<string, unknown>) => {
          filedAttention.push(item);
        },
      } as unknown as AttentionService;
      homeAssistant = new LocalHomeAssistantService(db, attention);
      realService = new HomeAssistantService(db, attention);
      smartHome = new SmartHomeService(db, homeAssistant);

      ownerUserId = generateId("user");
      await db.insert(schema.users).values({ id: ownerUserId, email: `ha-${ownerUserId}@example.com`, displayName: "Home Assistant Test" });

      connectionId = generateId("smartConnection");
      await db.insert(schema.smartConnections).values({
        id: connectionId,
        ownerUserId,
        provider: "home_assistant",
        status: "connected",
        apiBaseUrl: origin,
        apiToken: "secret-long-lived-token",
      });
    } catch (err) {
      // Rethrows anything that is NOT an unreachable database, so a real failure (a missing migration,
      // say) surfaces as a failure rather than quietly turning into a skipped suite that looks fine.
      dbAvailable = skipIfDatabaseUnreachable(err, "Home Assistant end-to-end test");
    }
  });

  afterAll(async () => {
    if (dbAvailable && db) {
      // The user cascades to the connection, its devices and their signals.
      await db.delete(schema.users).where(eq(schema.users.id, ownerUserId));
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("refuses an address it should not call, using the real guard", async () => {
    // The subclass used everywhere else in this file is exactly what must NOT be able to make this pass.
    const code = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
        return "NO_ERROR_THROWN";
      } catch (err) {
        const response = (err as { getResponse?: () => unknown })?.getResponse?.();
        return response && typeof response === "object" && "code" in response ? String((response as { code: unknown }).code) : "UNEXPECTED";
      }
    };
    // 169.254.169.254 is the single most valuable target for an SSRF in a hosted deployment. It is caught
    // by the string check before any lookup happens, which is why the code is HA_URL_LOCAL and not
    // URL_UNREACHABLE — the request is never made at all.
    expect(await code(() => realService.probe("https://169.254.169.254", "tok"))).toBe("HA_URL_LOCAL");
    expect(await code(() => realService.probe("https://127.0.0.1", "tok"))).toBe("HA_URL_LOCAL");
    expect(await code(() => realService.probe("http://home.example.com", "tok"))).toBe("HA_URL_INSECURE");
    expect(await code(() => realService.probe("not an address", "tok"))).toBe("HA_URL_INVALID");
  });

  it("asks the host guard about every single request, not just the first", async () => {
    if (!dbAvailable) return;
    // A hostname accepted last week can point at an internal address today, which is why this is checked
    // per request rather than once at connect. The guard's own refusals are tested in
    // `safe-url-fetcher.test.ts`; what is checked here is that this service actually calls it.
    guardCalls.length = 0;
    await homeAssistant.probe(origin, "secret-long-lived-token");
    await homeAssistant.fetchEntities(origin, "secret-long-lived-token");
    expect(guardCalls.length).toBeGreaterThanOrEqual(2);
    expect(new Set(guardCalls)).toEqual(new Set(["127.0.0.1"]));
  });

  it("verifies the token by actually using it before anything is stored", async () => {
    if (!dbAvailable) return;
    seen.length = 0;
    await homeAssistant.probe(origin, "secret-long-lived-token");
    expect(seen.some((c) => c.path === "/api/")).toBe(true);
  });

  it("sends the token as a bearer header, never in the URL", async () => {
    if (!dbAvailable) return;
    seen.length = 0;
    await homeAssistant.fetchEntities(origin, "secret-long-lived-token");
    expect(seen.length).toBeGreaterThan(0);
    for (const call of seen) {
      expect(call.auth).toBe("Bearer secret-long-lived-token");
      expect(call.path).not.toContain("secret-long-lived-token");
    }
  });

  it("says so when something answers that is not Home Assistant", async () => {
    if (!dbAvailable) return;
    apiRunning = false;
    try {
      await expect(homeAssistant.probe(origin, "tok")).rejects.toThrow(/wasn't Home Assistant/i);
    } finally {
      apiRunning = true;
    }
  });

  it("offers the household's devices and leaves the diagnostic clutter out", async () => {
    if (!dbAvailable) return;
    const devices = await smartHome.listAvailableDevices(connectionId, ownerUserId);
    const ids = devices.map((d) => d.providerDeviceId);
    expect(ids).toContain("binary_sensor.basement_water");
    expect(ids).toContain("sensor.front_door_lock_battery");
    expect(ids).toContain("lock.front_door");
    // Exact membership, not a substring search — "does not contain 'light'" would be satisfied by an
    // empty list, and a sweep that passes on an empty list measures nothing.
    expect(ids).not.toContain("sensor.wifi_signal_strength");
    expect(ids).not.toContain("automation.morning_lights");
    expect(ids).not.toContain("light.hallway");
  });

  it("imports nothing at all until the user selects something", async () => {
    if (!dbAvailable) return;
    // The Notification Access lesson, in a different place: a broad grant is not the authorization. The
    // token can read every entity in the house; the user's selection is what decides which are read.
    const before = await homeAssistant.sync(connectionId);
    expect(before.deviceCount).toBe(0);
    expect(before.signalCount).toBe(0);
    const rows = await db.select().from(schema.deviceSignals).where(eq(schema.deviceSignals.ownerUserId, ownerUserId));
    expect(rows).toHaveLength(0);
  });

  it("refuses to select a device the server does not offer", async () => {
    if (!dbAvailable) return;
    // Storing it would create a device row that can never match an entity and can therefore never produce
    // a signal — a selection that silently does nothing, which on screen looks exactly like one that works.
    await expect(smartHome.setSelectedDevices(connectionId, ownerUserId, ["binary_sensor.does_not_exist"])).rejects.toThrow(/isn't offered/i);
    await expect(smartHome.setSelectedDevices(connectionId, ownerUserId, ["light.hallway"])).rejects.toThrow(/isn't offered/i);
  });

  it("files the leak once the sensor is selected", async () => {
    if (!dbAvailable) return;
    await smartHome.setSelectedDevices(connectionId, ownerUserId, ["binary_sensor.basement_water", "sensor.front_door_lock_battery"]);
    const result = await homeAssistant.sync(connectionId);
    expect(result.signalCount).toBe(1);

    const [signal] = await db
      .select()
      .from(schema.deviceSignals)
      .where(eq(schema.deviceSignals.ownerUserId, ownerUserId))
      .orderBy(desc(schema.deviceSignals.occurredAt));
    expect(signal?.signalKind).toBe("leak");
    expect(signal?.severity).toBe("critical");
    // The detail column is encrypted at rest; reading it back through Drizzle proves the round trip.
    expect(signal?.detail).toContain("Basement Water Sensor");
    // The timestamp is the one Home Assistant reported, not the moment the sync happened.
    expect(signal?.occurredAt.toISOString()).toBe("2026-09-21T03:00:00.000Z");

    // And the household was actually TOLD. A signal filed into a table nobody reads is not a feature —
    // it is the silent-success failure this codebase keeps finding, and it is what this connector shipped
    // with until this assertion existed.
    expect(filedAttention, "a leak was recorded but nobody was told about it").toHaveLength(1);
    expect(filedAttention[0]?.urgency).toBe("critical");
    expect(String(filedAttention[0]?.reasonText)).toContain("Basement Water Sensor");
    expect(filedAttention[0]?.linkedResourceType).toBe("device_signal");
    // Never a guess: the device said so.
    expect(filedAttention[0]?.confidenceBand).toBe("verified");
  });

  it("does not file the same leak again on the next sync", async () => {
    if (!dbAvailable) return;
    // The basement is still wet. Without dedupe this files an obligation every time the worker ticks, and
    // a household that gets fifty notifications about one leak stops reading any of them.
    const again = await homeAssistant.sync(connectionId);
    expect(again.signalCount).toBe(0);
    const rows = await db.select().from(schema.deviceSignals).where(eq(schema.deviceSignals.ownerUserId, ownerUserId));
    expect(rows).toHaveLength(1);
  });

  it("files a SECOND, separate leak", async () => {
    if (!dbAvailable) return;
    // The opposite failure, and the worse one: a house that floods twice reporting once. The sensor dried
    // and got wet again, so `last_changed` moved, so this is genuinely new.
    basementWet = false;
    await homeAssistant.sync(connectionId);
    basementWet = true;
    basementChangedAt = "2026-09-28T19:30:00+00:00";
    const result = await homeAssistant.sync(connectionId);
    expect(result.signalCount).toBe(1);
    const rows = await db.select().from(schema.deviceSignals).where(eq(schema.deviceSignals.ownerUserId, ownerUserId));
    expect(rows).toHaveLength(2);
  });

  it("files a flat battery, and only once as it keeps dropping", async () => {
    if (!dbAvailable) return;
    lockBatteryPercent = "19";
    expect((await homeAssistant.sync(connectionId)).signalCount).toBe(1);
    // 19 -> 18 -> 17 changes `last_changed` every time. One flat battery, one obligation.
    lockBatteryPercent = "17";
    expect((await homeAssistant.sync(connectionId)).signalCount).toBe(0);
    lockBatteryPercent = "15";
    expect((await homeAssistant.sync(connectionId)).signalCount).toBe(0);
    // A worse band is different news and deserves to be heard.
    lockBatteryPercent = "4";
    expect((await homeAssistant.sync(connectionId)).signalCount).toBe(1);
  });

  it("stops reading a device the user deselects", async () => {
    if (!dbAvailable) return;
    await smartHome.setSelectedDevices(connectionId, ownerUserId, ["binary_sensor.basement_water"]);
    // Deliberately "unavailable" rather than another low battery percentage. A percentage would land in a
    // dedupe band already used, so this test would pass even if the deselection were ignored entirely —
    // it did, until falsification caught it. An offline signal has a key nothing here has produced.
    lockBatteryPercent = "unavailable";
    const result = await homeAssistant.sync(connectionId);
    expect(result.signalCount).toBe(0);

    // The device row survives deselection rather than being deleted, so the signals already filed against
    // it keep pointing at something.
    const [device] = await db
      .select()
      .from(schema.smartDevices)
      .where(
        and(
          eq(schema.smartDevices.smartConnectionId, connectionId),
          eq(schema.smartDevices.providerDeviceId, "sensor.front_door_lock_battery"),
        ),
      );
    expect(device?.isSelected).toBe(false);
  });

  it("stops syncing the moment a connection is marked disconnected, token or no token", async () => {
    if (!dbAvailable) return;
    // Disconnecting nulls the token AND sets the flag, so a test that only disconnects cannot tell which
    // of the two stopped the sync — and the flag being ignored would go unnoticed. This sets the flag
    // alone, leaving the credential in place, so only the flag can be doing the work.
    lockBatteryPercent = "84";
    await db.update(schema.smartConnections).set({ disconnectedAt: new Date() }).where(eq(schema.smartConnections.id, connectionId));
    basementChangedAt = "2026-09-30T02:00:00+00:00";
    const blocked = await homeAssistant.sync(connectionId);
    expect(blocked.signalCount).toBe(0);
    const rows = await db.select().from(schema.deviceSignals).where(eq(schema.deviceSignals.ownerUserId, ownerUserId));
    expect(rows.every((r) => r.dedupeKey.includes("2026-09-30") === false)).toBe(true);
    await db.update(schema.smartConnections).set({ disconnectedAt: null }).where(eq(schema.smartConnections.id, connectionId));
  });

  it("marks the connection healthy and stamps the time after a good sync", async () => {
    if (!dbAvailable) return;
    const [row] = await db.select().from(schema.smartConnections).where(eq(schema.smartConnections.id, connectionId));
    expect(row?.status).toBe("connected");
    expect(row?.healthDetail).toBeNull();
    expect(row?.lastSuccessfulSyncAt).toBeInstanceOf(Date);
  });

  it("tells the household a revoked token is a revoked token", async () => {
    if (!dbAvailable) return;
    // Telling them the wrong one is not cosmetic: "couldn't reach it" sends someone to check their router
    // when the fix is to generate a new token, and they will not find anything wrong with the router.
    tokenRejected = true;
    try {
      await expect(homeAssistant.sync(connectionId)).rejects.toThrow();
      const [row] = await db.select().from(schema.smartConnections).where(eq(schema.smartConnections.id, connectionId));
      expect(row?.status).toBe("error");
      expect(row?.healthDetail).toMatch(/rejected the saved token/i);
    } finally {
      tokenRejected = false;
    }
  });

  it("never hands the user's token back out of the list route", async () => {
    if (!dbAvailable) return;
    // `listSchoolSources` did exactly this once — a bare select() returned a Canvas token and an ICS URL
    // to every household member and delegate. One occurrence of that bug is enough.
    const listed = await smartHome.listConnections(ownerUserId);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("secret-long-lived-token");
    expect(listed[0]).not.toHaveProperty("apiToken");
    // The exact shape, not just the absence of one field. Falsification showed the earlier assertions
    // survived swapping the explicit column list for a bare select(), because the mapping below it was
    // what actually dropped the token — so "we select narrow columns" was not the thing being tested.
    // Pinning the key set means any new field reaching this route has to be added here deliberately.
    expect(Object.keys(listed[0] ?? {}).sort()).toEqual(
      ["baseUrl", "createdAt", "healthDetail", "id", "lastSuccessfulSyncAt", "provider", "selectedDevices", "status"],
    );
  });

  it("does not show one user's connection to another", async () => {
    if (!dbAvailable) return;
    const strangerId = generateId("user");
    await db.insert(schema.users).values({ id: strangerId, email: `ha-${strangerId}@example.com`, displayName: "Stranger" });
    try {
      expect(await smartHome.listConnections(strangerId)).toHaveLength(0);
      // Reported as "doesn't exist" rather than "not yours", so the route cannot be used to discover
      // whether an id belongs to somebody else.
      await expect(smartHome.listAvailableDevices(connectionId, strangerId)).rejects.toThrow(/doesn't exist/i);
      await expect(smartHome.setSelectedDevices(connectionId, strangerId, [])).rejects.toThrow(/doesn't exist/i);
      await expect(smartHome.disconnect(connectionId, strangerId)).rejects.toThrow(/doesn't exist/i);
    } finally {
      await db.delete(schema.users).where(eq(schema.users.id, strangerId));
    }
  });

  it("destroys the token on disconnect, and stops syncing", async () => {
    if (!dbAvailable) return;
    const signalsBefore = await db.select().from(schema.deviceSignals).where(eq(schema.deviceSignals.ownerUserId, ownerUserId));

    await smartHome.disconnect(connectionId, ownerUserId);

    const [row] = await db.select().from(schema.smartConnections).where(eq(schema.smartConnections.id, connectionId));
    // A disconnected connection holding a working Long-Lived Access Token is a credential kept for no
    // reason, with no screen that would ever show it again.
    expect(row?.apiToken).toBeNull();
    expect(row?.disconnectedAt).toBeInstanceOf(Date);
    expect(row?.status).toBe("not_configured");

    // And it genuinely stops: a sync after disconnect reads nothing and files nothing.
    basementChangedAt = "2026-10-05T06:00:00+00:00";
    const after = await homeAssistant.sync(connectionId);
    expect(after.signalCount).toBe(0);

    const signalsAfter = await db.select().from(schema.deviceSignals).where(eq(schema.deviceSignals.ownerUserId, ownerUserId));
    // The history of what was reported survives — deleting it on disconnect would quietly erase the
    // household's own record of a leak.
    expect(signalsAfter.length).toBe(signalsBefore.length);

    // It disappears from the list rather than lingering as a card that does nothing.
    expect(await smartHome.listConnections(ownerUserId)).toHaveLength(0);
  });
});
