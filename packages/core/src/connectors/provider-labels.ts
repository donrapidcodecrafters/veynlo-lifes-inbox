/**
 * What a connection is CALLED, in one place.
 *
 * ---------------------------------------------------------------------------------------------------
 * Why this is shared rather than defined per screen
 * ---------------------------------------------------------------------------------------------------
 * There were three copies of this map — apps/web's Connections page, apps/web's Privacy settings page,
 * and apps/mobile's Connections screen — and all three had drifted, in different directions:
 *
 *   Connections page  missing imap, caldav, carddav
 *   Privacy page      missing those three PLUS sharepoint, plaid, todoist, trello, asana and both
 *                     contacts providers — ten in all
 *   Mobile            its own subset again
 *
 * Every one of them ends in `?? provider`, so a provider with no entry does not fail: it renders the raw
 * lowercase database string. A connected bank showed as "plaid" on the privacy screen while showing as
 * "Bank accounts" one click away on Connections. That exact symptom had already been found and fixed once
 * on the Connections page; the fix could not spread, because each screen owned its own copy.
 *
 * A fallback that silently degrades to something plausible-looking is the hardest kind of bug to notice,
 * so the fallback is not the fix — having one map is.
 *
 * ---------------------------------------------------------------------------------------------------
 * Keeping it complete
 * ---------------------------------------------------------------------------------------------------
 * `KNOWN_CONNECTION_PROVIDERS` below is the full set of `connections.provider` values the API can store.
 * It is asserted against the API's own list in services/api's connector-registration test, so adding a
 * connector without naming it here fails there rather than shipping a screen that says "sharepoint".
 */

/** Every `connections.provider` value the API can write. Keep in step with INCREMENTAL_SYNC_PROVIDERS. */
export const KNOWN_CONNECTION_PROVIDERS = [
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
  "sharepoint",
  "dropbox",
  "google_tasks",
  "microsoft_todo",
  "todoist",
  "trello",
  "asana",
  "google_contacts",
  "microsoft_contacts",
  "plaid",
] as const;

export type KnownConnectionProvider = (typeof KNOWN_CONNECTION_PROVIDERS)[number];

/**
 * The name a person sees.
 *
 * Deliberately what the user would call the thing rather than what the code calls it: `plaid` is the
 * vendor this app happens to use, not something a household has heard of, so it reads "Bank accounts".
 */
export const PROVIDER_LABEL: Record<string, string> = {
  gmail: "Gmail",
  outlook: "Outlook",
  imap: "Mailbox (IMAP)",
  caldav: "Calendar server (CalDAV)",
  carddav: "Contacts server (CardDAV)",
  ics: "Calendar feed",
  google_calendar: "Google Calendar",
  microsoft_calendar: "Microsoft Calendar",
  google_drive: "Google Drive",
  onedrive: "OneDrive",
  sharepoint: "SharePoint",
  dropbox: "Dropbox",
  google_tasks: "Google Tasks",
  microsoft_todo: "Microsoft To Do",
  todoist: "Todoist",
  trello: "Trello",
  asana: "Asana",
  google_contacts: "Google Contacts",
  microsoft_contacts: "Microsoft Contacts",
  // Not "Plaid": the aggregator is an implementation detail, and nobody connects "a Plaid".
  plaid: "Bank accounts",
};

/**
 * The display name for a provider, never the raw database string.
 *
 * An unrecognised provider is title-cased rather than shown as-is, so even a value added to the API ahead
 * of this map reads as "Some New Provider" rather than "some_new_provider". That is a floor, not a
 * substitute for adding a real entry — the registration test is what makes sure a real one exists.
 */
export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return "Connection";
  const known = PROVIDER_LABEL[provider];
  if (known) return known;
  return provider
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
