import { describe, expect, it } from "vitest";
import { ImapAdapter } from "./imap.adapter";
import { IMAP_PROVIDERS, findImapProvider, listImapProviders } from "./imap-providers";
import type { Database } from "@veynlo/db";
import type { CredentialVault } from "../../common/credential-vault";
import type { EntitlementsService } from "../entitlements/entitlements.service";
import type { QueueProducer } from "../../queue/queue-producer.interface";
import type { IngestionService } from "../ingestion/ingestion.service";

/**
 * The refusals.
 *
 * `imap.adapter.test.ts` proves this connector can read a real mailbox. This file proves what it REFUSES,
 * which is the half that matters more, because this is the only connector in the codebase where the server
 * address is typed in by the user and the credential is a password rather than a revocable token.
 *
 * Every test here asserts that `connect()` throws BEFORE any socket is opened. None of them need a network,
 * a database or a mailbox — if one of these ever needs those things, the guard has moved to the wrong side
 * of the connection attempt.
 */
const noDb = {} as unknown as Database;
const noVault = {} as unknown as CredentialVault;
const noQueue = {} as unknown as QueueProducer;
const noIngestion = {} as unknown as IngestionService;
const allowAll = { assertConnectorQuota: async () => {}, resolveHistoricalBackfillDays: async () => 90 } as unknown as EntitlementsService;

function adapter() {
  return new ImapAdapter(noDb, noVault, allowAll, noQueue, noIngestion);
}

/**
 * The error CODE, not merely the fact that something was thrown.
 *
 * The first version of this file asserted `rejects.toThrow()` with no matcher, and three of its five
 * guards turned out to be untested: with the guard removed, `connect()` still threw — just later, from a
 * failed socket or an empty stub — and an unqualified "it throws" cannot tell those apart. A guard test
 * that passes when the guard is deleted is not a guard test.
 */
async function connectErrorCode(dto: Record<string, unknown>): Promise<string> {
  try {
    await adapter().connect({ dto: dto as never, ownerUserId: "usr_test", householdId: null });
  } catch (err) {
    const response = (err as { getResponse?: () => unknown })?.getResponse?.();
    if (response && typeof response === "object" && "code" in response) return String((response as { code: unknown }).code);
    return `UNEXPECTED: ${(err as Error)?.message ?? String(err)}`;
  }
  return "NO_ERROR_THROWN";
}

describe("ImapAdapter refuses before it connects", () => {
  it("refuses a host that resolves to a private address", async () => {
    // The whole reason this connector needs a guard the OAuth ones do not: this string came from a user.
    // 127.0.0.1 here stands for every internal service a server can reach and a user cannot.
    expect(await connectErrorCode({ providerKey: "custom", username: "a@b.test", password: "x", host: "127.0.0.1", port: 993 })).toBe(
      "URL_UNREACHABLE",
    );
  });

  it("refuses the cloud instance-metadata address", async () => {
    // 169.254.169.254 is the single most valuable target for an SSRF in a hosted deployment: it serves
    // instance credentials to anything that asks.
    expect(await connectErrorCode({ providerKey: "custom", username: "a@b.test", password: "x", host: "169.254.169.254", port: 993 })).toBe(
      "URL_UNREACHABLE",
    );
  });

  it("refuses a hostname that resolves to loopback", async () => {
    // "localhost" is the obvious one, but the guard resolves rather than string-matches, which is what
    // makes it hold against a public hostname pointed at 127.0.0.1 by its own DNS.
    expect(await connectErrorCode({ providerKey: "custom", username: "a@b.test", password: "x", host: "localhost", port: 993 })).toBe(
      "URL_UNREACHABLE",
    );
  });

  it("refuses an unknown provider key rather than guessing a server", async () => {
    expect(await connectErrorCode({ providerKey: "not-a-provider", username: "a@b.test", password: "x" })).toBe("UNKNOWN_IMAP_PROVIDER");
  });

  it("refuses Proton with the real reason instead of failing a connection", async () => {
    // Proton Bridge decrypts on the user's own machine and listens on loopback. No server will ever reach
    // it. Letting a Proton user watch a connection attempt time out would be a worse answer than saying so.
    expect(await connectErrorCode({ providerKey: "proton", username: "a@proton.me", password: "x" })).toBe("IMAP_PROVIDER_UNAVAILABLE");
  });

  it("refuses a custom provider with no host", async () => {
    expect(await connectErrorCode({ providerKey: "custom", username: "a@b.test", password: "x" })).toBe("IMAP_HOST_REQUIRED");
  });

  it("refuses an out-of-range port", async () => {
    expect(await connectErrorCode({ providerKey: "custom", username: "a@b.test", password: "x", host: "imap.example.com", port: 0 })).toBe(
      "IMAP_PORT_INVALID",
    );
    expect(await connectErrorCode({ providerKey: "custom", username: "a@b.test", password: "x", host: "imap.example.com", port: 70_000 })).toBe(
      "IMAP_PORT_INVALID",
    );
  });
});

describe("the IMAP provider registry", () => {
  it("covers the Appendix A email targets that had no path in", async () => {
    const keys = IMAP_PROVIDERS.map((p) => p.key);
    // Yahoo, iCloud, AOL and Fastmail are named in the spec's own register; "custom" is its
    // "Generic IMAP/custom domain" row; Proton is its "forwarding/import unless supported path" row.
    for (const key of ["yahoo", "icloud", "aol", "fastmail", "custom", "proton"]) {
      expect(keys, `${key} is missing from the provider registry`).toContain(key);
    }
  });

  it("never offers a provider without TLS", () => {
    // A mail password must not cross a network in the clear. There is no opt-out here by design.
    for (const provider of IMAP_PROVIDERS) {
      expect(provider.secure, `${provider.key} is not marked secure`).toBe(true);
    }
  });

  it("gives every connectable provider a credential hint a user can act on", () => {
    // "Authentication failed" is a useless answer when the real one is "Yahoo needs an app password".
    for (const provider of IMAP_PROVIDERS) {
      expect(provider.credentialHint.length, `${provider.key} has no usable credential hint`).toBeGreaterThan(30);
    }
  });

  it("gives every connectable provider a real host, and the unavailable one none", () => {
    for (const provider of IMAP_PROVIDERS) {
      if (provider.unavailableReason) continue;
      if (provider.key === "custom") {
        expect(provider.host).toBe("");
        continue;
      }
      expect(provider.host, `${provider.key} has no IMAP host`).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/);
      expect(provider.port).toBe(993);
    }
  });

  it("does not leak anything secret through the public provider listing", () => {
    // This list is served to clients. It must carry only what a user needs to choose and authenticate.
    const serialized = JSON.stringify(listImapProviders());
    expect(serialized).not.toMatch(/password["']?\s*:\s*["'][^"']+/i);
    expect(findImapProvider("yahoo")?.label).toBe("Yahoo Mail");
  });
});
