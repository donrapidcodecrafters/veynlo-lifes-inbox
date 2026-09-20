/**
 * Calendar and contact servers reachable over CalDAV and CardDAV.
 *
 * These are two more of the spec's feasibility class C rows — open standards, no partner agreement, no app
 * review — and between them they close four Appendix A targets that had no path in:
 *
 *   "CalDAV servers"            (Launch priority)
 *   "Apple Calendar / EventKit" (Launch priority) — iCloud speaks CalDAV, so a server CAN read it
 *   "CardDAV"                   (P2)
 *   "Apple Contacts"            (P2) — same, over CardDAV
 *
 * The Apple rows are the interesting ones. The register classes them A/B/C and the obvious reading is B:
 * EventKit, on the device, which is what `apps/mobile`'s "This phone's calendar" card already does. But
 * that is a manual, one-device import — it only ever sees what that particular phone has, and only when
 * someone taps it. iCloud also exposes both calendars and contacts over plain CalDAV/CardDAV with an
 * app-specific password, which is a real server-side connection that syncs on its own. Both are worth
 * having and they are not the same feature.
 *
 * Google is deliberately absent. Google's CalDAV endpoint requires OAuth rather than a password, and this
 * app already has a first-class Google Calendar connector — adding a second, worse path to the same data
 * would be a choice a user could only get wrong.
 */

export interface DavProvider {
  key: string;
  label: string;
  /** Base URL for discovery. Empty for "custom", where the user supplies it. */
  serverUrl: string;
  /** Which of the two protocols this entry offers. Most servers do both from the same root. */
  services: Array<"caldav" | "carddav">;
  credentialHint: string;
  credentialUrl: string | null;
}

export const DAV_PROVIDERS: DavProvider[] = [
  {
    key: "icloud",
    label: "iCloud (Apple Calendar & Contacts)",
    // Apple serves calendars and contacts from different hosts, so discovery starts at the calendar one
    // and the CardDAV adapter overrides it. Both accept the same Apple ID and app-specific password.
    serverUrl: "https://caldav.icloud.com",
    services: ["caldav", "carddav"],
    credentialHint:
      "iCloud needs an app-specific password, and two-factor authentication must already be on for your Apple Account. Use your full Apple ID as the username.",
    credentialUrl: "https://account.apple.com/account/manage",
  },
  {
    key: "fastmail",
    label: "Fastmail",
    serverUrl: "https://caldav.fastmail.com/dav/",
    services: ["caldav", "carddav"],
    credentialHint: "Fastmail needs an app password with calendar and contact access, created under Settings, Privacy & Security.",
    credentialUrl: "https://app.fastmail.com/settings/security/apps",
  },
  {
    key: "nextcloud",
    label: "Nextcloud / ownCloud",
    serverUrl: "",
    services: ["caldav", "carddav"],
    credentialHint:
      "Enter your server's DAV URL — usually https://your-server/remote.php/dav — and an app password from Settings, Security.",
    credentialUrl: null,
  },
  {
    key: "custom",
    label: "Other CalDAV/CardDAV server",
    serverUrl: "",
    services: ["caldav", "carddav"],
    credentialHint: "Enter your server's DAV URL and the username and password it expects.",
    credentialUrl: null,
  },
];

/** iCloud's contacts live on a different host from its calendars, despite sharing one credential. */
export const ICLOUD_CARDDAV_URL = "https://contacts.icloud.com";

export function findDavProvider(key: string): DavProvider | undefined {
  return DAV_PROVIDERS.find((p) => p.key === key);
}

export function listDavProviders(): DavProvider[] {
  return DAV_PROVIDERS;
}

/**
 * The URL to start discovery from, for a given provider and service.
 *
 * Kept here rather than in the adapter because the one real per-provider quirk — Apple splitting calendars
 * and contacts across two hosts — belongs next to the entry it describes, not buried in a sync method.
 */
export function davServerUrl(provider: DavProvider, service: "caldav" | "carddav", customUrl?: string): string | null {
  if (provider.key === "custom" || provider.key === "nextcloud") return customUrl?.trim() || null;
  if (provider.key === "icloud" && service === "carddav") return ICLOUD_CARDDAV_URL;
  return provider.serverUrl;
}
