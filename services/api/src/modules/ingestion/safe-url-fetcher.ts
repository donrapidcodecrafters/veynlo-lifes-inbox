import { Injectable, BadRequestException } from "@nestjs/common";
import { lookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";
import { Agent } from "undici";

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 5_000_000; // 5MB — a captured page's text content has no business being larger

/**
 * §CAP "URL capture" fetches a URL the user handed us — the server, not the browser, makes the request.
 * Without the checks below, that's a textbook SSRF primitive: an attacker could submit
 * `http://169.254.169.254/latest/meta-data/` (cloud instance metadata) or `http://localhost:6379/`
 * (an internal service) and use Veynlo's own server as a proxy to reach infrastructure the public
 * internet can't. Every hostname — including ones a redirect chain lands on — is resolved and checked
 * against private/reserved IP ranges *before* the request is made, not just validated as a URL string
 * (a hostname string tells you nothing about what it actually resolves to).
 */
@Injectable()
export class SafeUrlFetcher {
  async fetchReadableText(rawUrl: string): Promise<{ title: string; text: string; finalUrl: string }> {
    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      throw new BadRequestException({ code: "INVALID_URL", message: "That doesn't look like a valid URL." });
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        throw new BadRequestException({ code: "UNSUPPORTED_URL_SCHEME", message: "Only http/https URLs are supported." });
      }
      const validatedAddresses = await assertHostnameIsPublic(current.hostname);
      // DNS-rebinding TOCTOU fix: assertHostnameIsPublic already resolved and validated this hostname, but
      // a plain `fetch()` would perform its OWN independent DNS resolution moments later — an attacker
      // controlling DNS for the hostname (their own subdomain, a low TTL) could serve a public IP to the
      // check above and a private/internal IP to the real connection. Pinning the connector's lookup to
      // exactly the already-validated address(es) closes that window; TLS SNI/the Host header still use
      // the original hostname (undici's connector derives servername from the URL passed to fetch, not
      // from the lookup override), so this doesn't break name-based virtual hosting or certificate checks.
      const pinnedAgent = new Agent({
        connect: {
          lookup: (_hostname, _options, callback) => {
            callback(null, validatedAddresses.map((address) => ({ address, family: isIPv6(address) ? 6 : 4 })));
          },
        },
      });

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: controller.signal,
          headers: { "user-agent": "VeynloBot/1.0 (+https://veynlo.app)" },
          // @ts-expect-error -- `dispatcher` is a real, Node-supported undici extension to fetch's options
          // that isn't in the standard lib.dom RequestInit type.
          dispatcher: pinnedAgent,
        });
      } catch {
        throw new BadRequestException({ code: "URL_UNREACHABLE", message: "Couldn't reach that URL. Check it and try again." });
      } finally {
        clearTimeout(timeout);
        await pinnedAgent.close();
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new BadRequestException({ code: "URL_UNREACHABLE", message: "That URL redirected without a destination." });
        current = new URL(location, current); // re-validated at the top of the next loop iteration
        continue;
      }

      if (!response.ok) {
        throw new BadRequestException({ code: "URL_UNREACHABLE", message: `That page returned an error (${response.status}).` });
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        throw new BadRequestException({ code: "UNSUPPORTED_CONTENT_TYPE", message: "That URL isn't a readable web page." });
      }

      const html = await readBodyCapped(response, MAX_RESPONSE_BYTES);
      const title = extractTitle(html) ?? current.hostname;
      const text = stripHtml(html).slice(0, 20_000); // same cap gmail/outlook message parsing applies to email bodies
      return { title, text, finalUrl: current.toString() };
    }

    throw new BadRequestException({ code: "TOO_MANY_REDIRECTS", message: "That URL redirected too many times." });
  }
}

async function assertHostnameIsPublic(hostname: string): Promise<string[]> {
  let addresses: string[];
  try {
    const results = await lookup(hostname, { all: true, verbatim: true });
    addresses = results.map((r) => r.address);
  } catch {
    throw new BadRequestException({ code: "URL_UNREACHABLE", message: "Couldn't resolve that URL's address." });
  }
  if (addresses.length === 0) {
    throw new BadRequestException({ code: "URL_UNREACHABLE", message: "Couldn't resolve that URL's address." });
  }
  for (const address of addresses) {
    if (isPrivateOrReservedIp(address)) {
      // Deliberately the same generic "couldn't reach" message as a real network failure — never confirm
      // to the caller that a hostname resolves to an internal address, which is itself a minor information
      // leak about internal network topology.
      throw new BadRequestException({ code: "URL_UNREACHABLE", message: "Couldn't reach that URL. Check it and try again." });
    }
  }
  return addresses;
}

export function isPrivateOrReservedIp(address: string): boolean {
  if (isIPv4(address)) return isPrivateOrReservedIpv4(address);
  if (isIPv6(address)) return isPrivateOrReservedIpv6(address);
  return true; // unrecognized shape — fail closed
}

function isPrivateOrReservedIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true; // malformed — fail closed
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return true; // TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast (224-239) + reserved/broadcast (240-255)
  return false;
}

function isPrivateOrReservedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true; // loopback / unspecified
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7 unique-local
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (normalized.startsWith("ff")) return true; // ff00::/8 multicast
  // IPv4-mapped/compatible addresses (::ffff:a.b.c.d, ::a.b.c.d) — check the embedded IPv4.
  const mapped = normalized.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isPrivateOrReservedIpv4(mapped[1]);
  return false;
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1]).trim().slice(0, 500) || null : null;
}

function stripHtml(html: string): string {
  const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  return decodeHtmlEntities(withoutScripts.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
