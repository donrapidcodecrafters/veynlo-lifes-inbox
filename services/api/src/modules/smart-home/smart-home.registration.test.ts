import { describe, expect, it } from "vitest";
import { assertSmartHomeProvidersAreSyncable, SYNCABLE_SMART_HOME_PROVIDERS } from "./smart-home.service";
import { SmartHomeProviderSchema } from "./dto";

/**
 * A provider a user can connect must be a provider something actually polls.
 *
 * This is not a hypothetical. `imap`, `caldav` and `carddav` were all connectable, all synced once at
 * connect, and were then never scheduled again — three connectors sitting healthy and silent for thirteen
 * days, discovered only by measuring the queue directly. Nothing was broken in a way anyone could see: the
 * connection said "connected", the last sync time was real, and no error was ever raised.
 *
 * For a smart-home connector that failure would be worse. A leak sensor earns its place by noticing
 * something while nobody is looking; one that only updates when its settings screen is open would never
 * once tell a household anything they did not already know, and would look perfectly healthy doing it.
 */
describe("smart-home provider registration", () => {
  it("polls every provider a user is allowed to connect", () => {
    // The two lists are derived from the two places that actually decide: the DTO the connect route
    // validates against, and the list the recurring scan filters on.
    expect(() => assertSmartHomeProvidersAreSyncable(SmartHomeProviderSchema.options)).not.toThrow();
  });

  it("names the provider that drifted, rather than failing vaguely", () => {
    // A registration check whose message is "registration is inconsistent" costs whoever hits it an hour.
    expect(() => assertSmartHomeProvidersAreSyncable(["home_assistant", "smartthings"])).toThrow(/smartthings/);
    expect(() => assertSmartHomeProvidersAreSyncable(["home_assistant", "smartthings"])).toThrow(/never polled/i);
  });

  it("catches the drift in the other direction too", () => {
    // A scan that enqueues work nothing can do is quieter but just as wrong: the queue fills, every job
    // completes having done nothing, and the graph of "jobs processed" looks healthy.
    expect(() => assertSmartHomeProvidersAreSyncable([])).toThrow(/home_assistant/);
    expect(() => assertSmartHomeProvidersAreSyncable([])).toThrow(/not connectable/i);
  });

  it("is not vacuously satisfied by an empty list on either side", () => {
    // Guarding the guard: if both lists were somehow empty this check would pass while measuring nothing.
    expect(SYNCABLE_SMART_HOME_PROVIDERS.length).toBeGreaterThan(0);
    expect(SmartHomeProviderSchema.options.length).toBeGreaterThan(0);
  });
});
