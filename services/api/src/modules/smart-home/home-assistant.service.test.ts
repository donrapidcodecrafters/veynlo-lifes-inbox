import { describe, expect, it } from "vitest";
import {
  haDeviceType,
  homeAssistantDevices,
  homeAssistantOrigin,
  homeAssistantSignal,
  isObviouslyLocalHostname,
  isOfferedEntity,
  parseHomeAssistantStates,
  type HaEntity,
} from "./home-assistant.service";

/**
 * Home Assistant is the only smart-home provider in Appendix A this deployment can actually connect to,
 * and the address is typed in by the user — the same untrusted-input shape as the Canvas host and the
 * custom IMAP server.
 *
 * Two things here can hurt a household. The first is silence: a leak sensor that is wet and files nothing,
 * or a selection that appears to save and imports no device. The second is noise: the same flat battery
 * filed on every sync until the household stops reading any of it.
 */

const entity = (over: Partial<HaEntity> & { entityId: string }): HaEntity => ({
  state: "off",
  deviceClass: null,
  friendlyName: null,
  unit: null,
  lastChanged: "2026-09-21T04:00:00+00:00",
  ...over,
});

describe("recognising a home-network address", () => {
  it("knows the addresses a Home Assistant actually lives on", () => {
    // Every one of these is what a user would find in their own browser's address bar, which makes them
    // the most likely thing to be pasted into the connect field.
    for (const host of [
      "homeassistant.local",
      "homeassistant",
      "hassio",
      "192.168.1.40",
      "10.0.0.5",
      "172.16.4.2",
      "172.31.255.254",
      "127.0.0.1",
      "localhost",
      "ha.lan",
      "ha.home",
      "ha.internal",
      "169.254.10.1",
      "100.72.3.4",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isObviouslyLocalHostname(host), host).toBe(true);
    }
  });

  it("does not mistake a real remote address for a local one", () => {
    // A false positive here is worse than a false negative: it refuses an address that would have worked,
    // and the user has no way to argue with it.
    for (const host of [
      "abc123.ui.nabu.casa",
      "home.example.com",
      "myhome.duckdns.org",
      "203.0.113.10",
      "172.32.0.1", // just outside the private 172.16/12 range
      "172.15.0.1", // just below it
      "10a.example.com", // starts with "10" but is not 10.x
      "notlocal.locally.com",
    ]) {
      expect(isObviouslyLocalHostname(host), host).toBe(false);
    }
  });

  it("is case-insensitive, because a pasted address often is not lowercase", () => {
    expect(isObviouslyLocalHostname("HomeAssistant.Local")).toBe(true);
  });
});

describe("the Home Assistant address", () => {
  it("accepts a bare hostname, because that is what people paste", () => {
    expect(homeAssistantOrigin("abc123.ui.nabu.casa")).toBe("https://abc123.ui.nabu.casa");
    expect(homeAssistantOrigin("  abc123.ui.nabu.casa  ")).toBe("https://abc123.ui.nabu.casa");
  });

  it("keeps only the origin, so a pasted dashboard link cannot smuggle a path into every request", () => {
    expect(homeAssistantOrigin("https://abc123.ui.nabu.casa/lovelace/0?edit=1")).toBe("https://abc123.ui.nabu.casa");
  });

  it("keeps a non-standard port rather than silently dropping it", () => {
    // Home Assistant is served on 8123 by default and a user proxying it will have their own port.
    // Quietly rewriting to 443 would produce "couldn't reach it" for an address that was correct.
    expect(homeAssistantOrigin("https://home.example.com:8123/x")).toBe("https://home.example.com:8123");
  });

  it("tells a user with a LAN-only server exactly what is wrong, instead of a generic network error", () => {
    // This is the whole point of the local-address check. Without it the SSRF guard refuses the request
    // and reports "couldn't reach that URL" — and the user goes looking for a broken token.
    expect(() => homeAssistantOrigin("http://homeassistant.local:8123")).toThrow(/home-network address/i);
    expect(() => homeAssistantOrigin("https://192.168.1.40:8123")).toThrow(/home-network address/i);
  });

  it("names a remote address the user could actually go and get", () => {
    // An error that says only "that won't work" leaves someone stuck. This one has to name the fix.
    expect(() => homeAssistantOrigin("http://192.168.1.40:8123")).toThrow(/nabu\.casa|reverse proxy|DuckDNS/i);
  });

  it("checks for a local address BEFORE the https rule", () => {
    // Ordering matters and is easy to get backwards. A LAN instance is nearly always plain http, so a
    // scheme check running first would tell every such user to "use https" — advice that cannot be
    // followed and does not describe their actual problem.
    expect(() => homeAssistantOrigin("http://homeassistant.local:8123")).toThrow(/home-network/i);
    expect(() => homeAssistantOrigin("http://homeassistant.local:8123")).not.toThrow(/start with https/i);
  });

  it("refuses plain http on a public address, which would put the token on the wire in the clear", () => {
    expect(() => homeAssistantOrigin("http://home.example.com")).toThrow(/https/i);
  });

  it("refuses a non-http scheme outright", () => {
    expect(() => homeAssistantOrigin("file:///etc/passwd")).toThrow();
    expect(() => homeAssistantOrigin("gopher://internal")).toThrow();
  });

  it("refuses an empty address with an instruction rather than a parse error", () => {
    expect(() => homeAssistantOrigin("")).toThrow(/enter the web address/i);
    expect(() => homeAssistantOrigin("   ")).toThrow(/enter the web address/i);
  });
});

describe("classifying an entity", () => {
  it("reads the kind of thing from the entity id's domain", () => {
    expect(haDeviceType("lock.front_door")).toBe("lock");
    expect(haDeviceType("climate.living_room")).toBe("thermostat");
    expect(haDeviceType("water_heater.tank")).toBe("thermostat");
    expect(haDeviceType("camera.driveway")).toBe("camera");
    expect(haDeviceType("sensor.kitchen_battery")).toBe("sensor");
    expect(haDeviceType("binary_sensor.basement_water")).toBe("sensor");
    expect(haDeviceType("light.hallway")).toBe("other");
    expect(haDeviceType("nonsense")).toBe("other");
  });

  it("offers the things a household cares about", () => {
    expect(isOfferedEntity({ entityId: "lock.front_door", deviceClass: null })).toBe(true);
    expect(isOfferedEntity({ entityId: "camera.driveway", deviceClass: null })).toBe(true);
    expect(isOfferedEntity({ entityId: "binary_sensor.basement", deviceClass: "moisture" })).toBe(true);
    expect(isOfferedEntity({ entityId: "sensor.lock_battery", deviceClass: "battery" })).toBe(true);
  });

  it("leaves out the diagnostic clutter a real installation is full of", () => {
    // A live Home Assistant has hundreds of these. Offering them all turns device selection into a chore
    // nobody finishes, and a picker nobody finishes is a feature nobody uses.
    expect(isOfferedEntity({ entityId: "sensor.sun_next_dawn", deviceClass: "timestamp" })).toBe(false);
    expect(isOfferedEntity({ entityId: "sensor.wifi_signal", deviceClass: "signal_strength" })).toBe(false);
    expect(isOfferedEntity({ entityId: "sensor.firmware_version", deviceClass: null })).toBe(false);
    expect(isOfferedEntity({ entityId: "automation.morning", deviceClass: null })).toBe(false);
    expect(isOfferedEntity({ entityId: "light.hallway", deviceClass: null })).toBe(false);
  });
});

describe("reading /api/states", () => {
  it("takes the fields it needs and ignores the rest of the payload", () => {
    const parsed = parseHomeAssistantStates([
      {
        entity_id: "binary_sensor.basement_water",
        state: "on",
        attributes: { device_class: "moisture", friendly_name: "Basement Water Sensor", extra: "ignored" },
        last_changed: "2026-09-21T03:00:00+00:00",
        context: { id: "01J", user_id: null },
      },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      entityId: "binary_sensor.basement_water",
      state: "on",
      deviceClass: "moisture",
      friendlyName: "Basement Water Sensor",
    });
  });

  it("refuses anything that is not a Home Assistant entity", () => {
    // If the address turns out to answer with some other service's JSON, none of it should survive as a
    // half-populated device row.
    expect(parseHomeAssistantStates(null)).toEqual([]);
    expect(parseHomeAssistantStates({ message: "API running." })).toEqual([]);
    expect(parseHomeAssistantStates("not json")).toEqual([]);
    expect(parseHomeAssistantStates([null, 42, "x", {}, { entity_id: 5 }])).toEqual([]);
    // No dot means no domain, which means it did not come from Home Assistant.
    expect(parseHomeAssistantStates([{ entity_id: "no_domain_here", state: "on" }])).toEqual([]);
  });

  it("survives an entity with no attributes at all", () => {
    const parsed = parseHomeAssistantStates([{ entity_id: "lock.front_door", state: "locked" }]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.friendlyName).toBeNull();
    expect(parsed[0]?.deviceClass).toBeNull();
  });
});

describe("what a user is offered to choose from", () => {
  it("uses the name the user gave the device in their own house", () => {
    const devices = homeAssistantDevices([
      entity({ entityId: "binary_sensor.basement_water", deviceClass: "moisture", friendlyName: "Basement Water Sensor" }),
    ]);
    expect(devices[0]?.label).toBe("Basement Water Sensor");
  });

  it("falls back to the entity id rather than inventing a name", () => {
    const devices = homeAssistantDevices([entity({ entityId: "lock.front_door" })]);
    expect(devices[0]?.label).toBe("lock.front_door");
  });

  it("drops the clutter and keeps the rest", () => {
    const devices = homeAssistantDevices([
      entity({ entityId: "lock.front_door", friendlyName: "Front Door" }),
      entity({ entityId: "sensor.sun_next_dawn", deviceClass: "timestamp", friendlyName: "Next dawn" }),
      entity({ entityId: "binary_sensor.basement_water", deviceClass: "moisture", friendlyName: "Basement Water" }),
      entity({ entityId: "light.hallway", friendlyName: "Hallway" }),
    ]);
    expect(devices.map((d) => d.providerDeviceId)).toEqual(["lock.front_door", "binary_sensor.basement_water"]);
  });
});

describe("deciding what is worth telling a household about", () => {
  it("files a leak the moment a moisture sensor is wet", () => {
    const signal = homeAssistantSignal(
      entity({ entityId: "binary_sensor.basement_water", state: "on", deviceClass: "moisture", friendlyName: "Basement Water Sensor" }),
    );
    expect(signal?.signalKind).toBe("leak");
    expect(signal?.severity).toBe("critical");
    expect(signal?.detail).toContain("Basement Water Sensor");
  });

  it("treats smoke, gas and carbon monoxide as critical", () => {
    for (const deviceClass of ["smoke", "gas", "carbon_monoxide"]) {
      const signal = homeAssistantSignal(entity({ entityId: `binary_sensor.x_${deviceClass}`, state: "on", deviceClass }));
      expect(signal?.signalKind, deviceClass).toBe("smoke_co");
      expect(signal?.severity, deviceClass).toBe("critical");
    }
  });

  it("files nothing when the sensor is dry", () => {
    expect(homeAssistantSignal(entity({ entityId: "binary_sensor.basement_water", state: "off", deviceClass: "moisture" }))).toBeNull();
  });

  it("reports a device that has gone unreachable", () => {
    const signal = homeAssistantSignal(entity({ entityId: "lock.front_door", state: "unavailable", friendlyName: "Front Door" }));
    expect(signal?.signalKind).toBe("offline");
    expect(signal?.detail).toContain("Front Door");
  });

  it("does NOT treat 'unknown' as offline", () => {
    // Every entity is "unknown" for a moment after the server restarts. Filing that as a device fault
    // would put a false alarm in front of the household every time they reboot Home Assistant, and a
    // notification that is usually wrong is one people learn to ignore.
    expect(homeAssistantSignal(entity({ entityId: "lock.front_door", state: "unknown" }))).toBeNull();
  });

  it("reads a battery percentage and files it only when it is genuinely low", () => {
    expect(homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "85", deviceClass: "battery" }))).toBeNull();
    expect(homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "20", deviceClass: "battery" }))).toBeNull();
    const low = homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "12", deviceClass: "battery", friendlyName: "Front Door Lock Battery" }));
    expect(low?.signalKind).toBe("battery_low");
    expect(low?.detail).toContain("12%");
  });

  it("does not read a battery percentage out of something that is not a number", () => {
    // A battery entity can report "unknown", and `Number("unknown")` is NaN — which must not become a
    // battery-low signal, and must not become a signal claiming "battery at NaN%".
    expect(homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "unknown", deviceClass: "battery" }))).toBeNull();
    expect(homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "", deviceClass: "battery" }))).toBeNull();
  });

  it("ignores a device class it has no meaning for", () => {
    expect(homeAssistantSignal(entity({ entityId: "binary_sensor.front_door", state: "on", deviceClass: "door" }))).toBeNull();
    expect(homeAssistantSignal(entity({ entityId: "binary_sensor.motion", state: "on", deviceClass: "motion" }))).toBeNull();
  });

  it("does not turn an open door or an unlocked lock into an alarm", () => {
    // An open door is a fact, not a fault. Filing it as one would bury the leak and the smoke alarm under
    // a stream of things that are simply how a house is used.
    expect(homeAssistantSignal(entity({ entityId: "lock.front_door", state: "unlocked" }))).toBeNull();
    expect(homeAssistantSignal(entity({ entityId: "binary_sensor.garage", state: "on", deviceClass: "garage_door" }))).toBeNull();
  });
});

describe("filing the same thing twice", () => {
  it("gives one wet sensor the same key on every sync until it dries", () => {
    // This is what stops a leak that stays wet from filing an obligation every fifteen minutes. The state
    // has not changed, so `last_changed` has not changed, so the key is the same.
    const wet = entity({ entityId: "binary_sensor.basement_water", state: "on", deviceClass: "moisture", lastChanged: "2026-09-21T03:00:00+00:00" });
    expect(homeAssistantSignal(wet)?.dedupeKey).toBe(homeAssistantSignal(wet)?.dedupeKey);
  });

  it("gives a SECOND leak a different key, so it is not swallowed by the first", () => {
    // The opposite failure, and the worse one: a house that flooded twice reporting once.
    const first = homeAssistantSignal(entity({ entityId: "binary_sensor.basement_water", state: "on", deviceClass: "moisture", lastChanged: "2026-09-21T03:00:00+00:00" }));
    const second = homeAssistantSignal(entity({ entityId: "binary_sensor.basement_water", state: "on", deviceClass: "moisture", lastChanged: "2026-09-28T19:30:00+00:00" }));
    expect(first?.dedupeKey).not.toBe(second?.dedupeKey);
  });

  it("does not file a flat battery again for every percent it drops", () => {
    // A battery reading ticking 19 -> 18 -> 17 changes `last_changed` each time. Keyed on that, one flat
    // battery would produce three obligations. Keyed on a ten-percent band, it produces one.
    const at19 = homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "19", deviceClass: "battery", lastChanged: "2026-09-21T03:00:00+00:00" }));
    const at17 = homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "17", deviceClass: "battery", lastChanged: "2026-09-22T09:14:00+00:00" }));
    expect(at19?.dedupeKey).toBe(at17?.dedupeKey);
  });

  it("files again once a battery falls into a worse band", () => {
    // 19% and 4% are not the same news, and the second deserves to be heard even though the first was
    // already reported.
    const at19 = homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "19", deviceClass: "battery" }));
    const at4 = homeAssistantSignal(entity({ entityId: "sensor.lock_battery", state: "4", deviceClass: "battery" }));
    expect(at19?.dedupeKey).not.toBe(at4?.dedupeKey);
    expect(at4?.severity).toBe("warning");
  });

  it("never lets two different devices share a key", () => {
    const a = homeAssistantSignal(entity({ entityId: "binary_sensor.basement_water", state: "on", deviceClass: "moisture" }));
    const b = homeAssistantSignal(entity({ entityId: "binary_sensor.kitchen_water", state: "on", deviceClass: "moisture" }));
    expect(a?.dedupeKey).not.toBe(b?.dedupeKey);
  });
});
