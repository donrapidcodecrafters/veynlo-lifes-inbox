import { describe, expect, it } from "vitest";
import { CalDavAdapter } from "./caldav.adapter";
import { DAV_PROVIDERS, findDavProvider, davServerUrl, ICLOUD_CARDDAV_URL } from "./dav-providers";

/**
 * What the DAV connectors refuse, and why.
 *
 * `caldav.adapter.test.ts` proves the happy path against a real server. This proves the refusals, which is
 * the half that matters more: like IMAP, and unlike every OAuth connector here, the server address is
 * typed in by the user and the credential is a password rather than a revocable token.
 *
 * Every assertion checks the specific error CODE. An earlier version of the IMAP equivalent asserted only
 * "it throws", and three of its five guards turned out to pass with the guard deleted — because everything
 * throws eventually. That mistake is not repeated here.
 */
async function serverErrorCode(dto: Record<string, unknown>, service: "caldav" | "carddav" = "caldav"): Promise<string> {
  try {
    await CalDavAdapter.resolveServer(dto as never, service);
  } catch (err) {
    const response = (err as { getResponse?: () => unknown })?.getResponse?.();
    if (response && typeof response === "object" && "code" in response) return String((response as { code: unknown }).code);
    return `UNEXPECTED: ${(err as Error)?.message ?? String(err)}`;
  }
  return "NO_ERROR_THROWN";
}

describe("DAV server resolution refuses before it connects", () => {
  it("refuses a host that resolves to a private address", async () => {
    // This string came from a user. 127.0.0.1 stands for every internal service a server can reach.
    expect(await serverErrorCode({ providerKey: "custom", username: "a", password: "x", serverUrl: "https://127.0.0.1/dav/" })).toBe(
      "URL_UNREACHABLE",
    );
  });

  it("refuses the cloud instance-metadata address", async () => {
    expect(await serverErrorCode({ providerKey: "custom", username: "a", password: "x", serverUrl: "https://169.254.169.254/dav/" })).toBe(
      "URL_UNREACHABLE",
    );
  });

  it("refuses a hostname that resolves to loopback", async () => {
    expect(await serverErrorCode({ providerKey: "custom", username: "a", password: "x", serverUrl: "https://localhost/dav/" })).toBe(
      "URL_UNREACHABLE",
    );
  });

  it("refuses plain http, because the password would cross the network in the clear", async () => {
    expect(await serverErrorCode({ providerKey: "custom", username: "a", password: "x", serverUrl: "http://dav.example.com/dav/" })).toBe(
      "DAV_TLS_REQUIRED",
    );
  });

  it("refuses something that is not a URL at all", async () => {
    expect(await serverErrorCode({ providerKey: "custom", username: "a", password: "x", serverUrl: "not a url" })).toBe("DAV_URL_INVALID");
  });

  it("refuses an unknown provider rather than guessing a server", async () => {
    expect(await serverErrorCode({ providerKey: "not-a-provider", username: "a", password: "x" })).toBe("UNKNOWN_DAV_PROVIDER");
  });

  it("refuses a custom provider with no address", async () => {
    expect(await serverErrorCode({ providerKey: "custom", username: "a", password: "x" })).toBe("DAV_URL_REQUIRED");
  });
});

describe("the DAV provider registry", () => {
  it("covers the Appendix A rows this closes", () => {
    const keys = DAV_PROVIDERS.map((p) => p.key);
    // iCloud closes "Apple Calendar" and "Apple Contacts"; custom closes "CalDAV servers" and "CardDAV".
    for (const key of ["icloud", "fastmail", "nextcloud", "custom"]) {
      expect(keys, `${key} is missing from the provider registry`).toContain(key);
    }
  });

  it("only ever offers https addresses", () => {
    // A calendar password must not cross a network in the clear, and there is no opt-out by design.
    for (const provider of DAV_PROVIDERS) {
      if (!provider.serverUrl) continue;
      expect(provider.serverUrl.startsWith("https://"), `${provider.key} is not https`).toBe(true);
    }
  });

  it("sends iCloud contacts to Apple's contacts host, not its calendar host", () => {
    // The one real per-provider quirk: Apple splits calendars and contacts across two hosts while sharing
    // a single credential. Getting this wrong authenticates fine and then finds no address books at all,
    // which looks like an empty account rather than a wrong URL.
    const icloud = findDavProvider("icloud")!;
    expect(davServerUrl(icloud, "caldav")).toBe("https://caldav.icloud.com");
    expect(davServerUrl(icloud, "carddav")).toBe(ICLOUD_CARDDAV_URL);
    expect(davServerUrl(icloud, "carddav")).not.toBe(davServerUrl(icloud, "caldav"));
  });

  it("uses the user's own address for the providers that need one", () => {
    const custom = findDavProvider("custom")!;
    expect(davServerUrl(custom, "caldav", "https://dav.example.com/")).toBe("https://dav.example.com/");
    expect(davServerUrl(custom, "caldav")).toBeNull();
  });

  it("gives every provider a credential hint a user can act on", () => {
    for (const provider of DAV_PROVIDERS) {
      expect(provider.credentialHint.length, `${provider.key} has no usable credential hint`).toBeGreaterThan(30);
    }
  });
});
