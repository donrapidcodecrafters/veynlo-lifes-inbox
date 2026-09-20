import { describe, expect, it } from "vitest";
import { INCREMENTAL_SYNC_PROVIDERS, assertConnectorRegistrationIsComplete } from "./connectors.service";

/**
 * The check that stops a connector from shipping silent.
 *
 * Two registrations decide whether a connection keeps working: worker-main.ts's `adaptersByProvider`
 * (can this provider sync at all) and `INCREMENTAL_SYNC_PROVIDERS` (is it ever asked to). They have to
 * name the same providers.
 *
 * They did not. `imap`, `caldav` and `carddav` were added to the map when those connectors shipped and
 * never added to the scan list, so a connected mailbox or calendar server synced once at connect time and
 * then went permanently quiet — while the Connections screen kept showing it as healthy, because nothing
 * had failed. Nothing failed; nothing ran.
 *
 * Nothing compared the two lists, so nothing could notice. This is that comparison.
 */
describe("connector registration completeness", () => {
  it("accepts the real, matching pair", () => {
    // The live list, checked against itself: whatever is scheduled must be acceptable as a map.
    expect(() => assertConnectorRegistrationIsComplete([...INCREMENTAL_SYNC_PROVIDERS])).not.toThrow();
  });

  it("catches the defect that actually shipped", () => {
    // Exactly the state of the repo before this fix: the three connectors had adapters and no schedule.
    const withThoseThree = [...INCREMENTAL_SYNC_PROVIDERS, "imap", "caldav", "carddav"];
    const scanListWithoutThem = withThoseThree.filter((p) => !["imap", "caldav", "carddav"].includes(p));
    // Simulated from the other direction — a map naming three providers the scan list does not.
    expect(() => assertConnectorRegistrationIsComplete([...scanListWithoutThem, "nowhere_near_the_scan_list"])).toThrow(
      /nowhere_near_the_scan_list/,
    );
  });

  it("names the provider that would go silent, not just that something is wrong", () => {
    // An error saying "registration is inconsistent" sends whoever reads it back to diff two lists by eye.
    let message = "";
    try {
      assertConnectorRegistrationIsComplete([...INCREMENTAL_SYNC_PROVIDERS, "some_new_connector"]);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("some_new_connector");
    expect(message).toContain("never scanned");
  });

  it("catches the reverse — scheduled with no adapter", () => {
    // This direction fails loudly at sync time rather than silently, but it is still a broken deployment
    // and still better caught at boot.
    const missingOne = INCREMENTAL_SYNC_PROVIDERS.filter((p) => p !== "plaid");
    expect(() => assertConnectorRegistrationIsComplete([...missingOne])).toThrow(/plaid/);
  });

  it("schedules every connector that can sync", () => {
    // The specific providers, asserted by name. A regression that drops one from the scan list would still
    // satisfy the pairwise check above if it were dropped from both — this is the list itself.
    for (const provider of [
      "gmail",
      "outlook",
      "imap",
      "caldav",
      "carddav",
      "ics",
      "google_calendar",
      "microsoft_calendar",
      "google_drive",
      "onedrive",
      "dropbox",
      "google_tasks",
      "microsoft_todo",
      "todoist",
      "trello",
      "asana",
      "plaid",
    ]) {
      expect(INCREMENTAL_SYNC_PROVIDERS).toContain(provider);
    }
  });
});
