/**
 * The mailboxes this app can connect to over IMAP, and what each one actually requires.
 *
 * Spec Appendix A lists eight email targets. Two were built (Gmail, Outlook, both OAuth). The other six —
 * Yahoo, iCloud, AOL, Fastmail, Proton and any custom domain — had no path in at all: a user on any of
 * them could sign up, land on a Connections screen, and find nothing they could connect. Forwarding to
 * their inbound alias was the only route, and it is a manual one they have to remember to keep doing.
 *
 * Every provider here is reached over IMAP, which is spec feasibility class C — an open standard, no
 * partner agreement, no app review. What differs between them is the CREDENTIAL, and that difference is
 * the entire reason this file exists rather than one "IMAP server" text field:
 *
 *   - Yahoo and AOL: an app password, generated in account security settings. Their normal password is
 *     rejected by the IMAP endpoint outright.
 *   - iCloud: an app-specific password, and two-factor must already be on. Apple gives no other option.
 *   - Fastmail: an app password, scoped to mail.
 *   - Everything else: whatever that server wants.
 *
 * Telling a user "authentication failed" when the real answer is "Yahoo needs an app password, here is
 * where to make one" is the difference between a connector that works and one that gets abandoned at the
 * first attempt. So each entry carries the sentence its own users need.
 *
 * Proton is deliberately listed and deliberately not connectable. Proton Mail has no public IMAP endpoint
 * — mail is decrypted locally by Proton Bridge, which runs on the user's own machine and listens on
 * 127.0.0.1. A server cannot reach that, and it never will be able to. Saying so plainly is better than
 * omitting Proton and letting a Proton user conclude the app simply forgot about them.
 */

export interface ImapProvider {
  key: string;
  label: string;
  host: string;
  port: number;
  /** Always true here. A mail password must not cross the network in the clear, so a provider that cannot offer TLS is not offered. */
  secure: boolean;
  /** What to tell the user they need, in their own provider's words. */
  credentialHint: string;
  /** Where that credential is created, when the provider has a stable page for it. */
  credentialUrl: string | null;
  /** Set when the provider cannot be reached from a server at all — listed for honesty, never connectable. */
  unavailableReason?: string;
}

export const IMAP_PROVIDERS: ImapProvider[] = [
  {
    key: "yahoo",
    label: "Yahoo Mail",
    host: "imap.mail.yahoo.com",
    port: 993,
    secure: true,
    credentialHint:
      "Yahoo requires an app password — your normal Yahoo password will be rejected. Generate one under Account Security, then paste it here.",
    credentialUrl: "https://login.yahoo.com/account/security",
  },
  {
    key: "icloud",
    label: "iCloud Mail",
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    credentialHint:
      "iCloud requires an app-specific password, and two-factor authentication must already be turned on for your Apple Account. Generate one under Sign-In and Security, then paste it here.",
    credentialUrl: "https://account.apple.com/account/manage",
  },
  {
    key: "aol",
    label: "AOL Mail",
    host: "imap.aol.com",
    port: 993,
    secure: true,
    credentialHint: "AOL requires an app password — your normal password will be rejected. Generate one under Account Security.",
    credentialUrl: "https://login.aol.com/account/security",
  },
  {
    key: "fastmail",
    label: "Fastmail",
    host: "imap.fastmail.com",
    port: 993,
    secure: true,
    credentialHint: "Fastmail requires an app password with mail access. Create one under Settings, Privacy & Security, App Passwords.",
    credentialUrl: "https://app.fastmail.com/settings/security/apps",
  },
  {
    key: "zoho",
    label: "Zoho Mail",
    host: "imap.zoho.com",
    port: 993,
    secure: true,
    credentialHint: "Zoho requires an application-specific password when two-factor authentication is on.",
    credentialUrl: null,
  },
  {
    key: "gmx",
    label: "GMX",
    host: "imap.gmx.com",
    port: 993,
    secure: true,
    credentialHint: "GMX requires IMAP to be enabled first, under Settings, POP3 & IMAP.",
    credentialUrl: null,
  },
  {
    key: "proton",
    label: "Proton Mail",
    host: "",
    port: 0,
    secure: true,
    credentialHint:
      "Proton Mail cannot be connected directly. Your mail is decrypted by Proton Bridge on your own computer, which is not reachable from a server — forward mail to your Veynlo address instead.",
    credentialUrl: null,
    unavailableReason:
      "Proton Mail exposes no public IMAP endpoint. Proton Bridge decrypts locally and listens on your own machine, so no server can reach it. Forwarding to your Veynlo address is the supported path.",
  },
  {
    key: "custom",
    label: "Other mail provider",
    host: "",
    port: 993,
    secure: true,
    credentialHint:
      "Enter your provider's IMAP server and the password it expects. Many providers require an app password rather than your normal one when two-factor authentication is on.",
    credentialUrl: null,
  },
];

export function findImapProvider(key: string): ImapProvider | undefined {
  return IMAP_PROVIDERS.find((p) => p.key === key);
}

/** What the Connections screen lists — everything, including the one that says why it cannot be used. */
export function listImapProviders(): Array<Omit<ImapProvider, "secure">> {
  return IMAP_PROVIDERS.map(({ secure: _secure, ...rest }) => rest);
}
