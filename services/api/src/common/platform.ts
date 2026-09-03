import type { FastifyRequest } from "fastify";

const KNOWN_PLATFORMS = ["ios", "android", "web", "macos", "windows", "extension"] as const;
export type ClientPlatform = (typeof KNOWN_PLATFORMS)[number];

/** Every client sends this header (see each app's api-client.ts); defaults to "web" for anything absent
 * or unrecognized, matching a plain browser hitting the API directly. */
export function detectPlatform(req: FastifyRequest): ClientPlatform {
  const header = String(req.headers["x-veynlo-platform"] ?? "web");
  return (KNOWN_PLATFORMS as readonly string[]).includes(header) ? (header as ClientPlatform) : "web";
}

/** Same allowlist as `detectPlatform`, for the one class of request that can't carry a custom header at
 * all: a system-browser navigation `Linking.openURL` opens (mobile OAuth sign-in's authorize routes, hit
 * directly by the OS browser rather than an authenticated in-app fetch) has to travel platform as a query
 * param instead. */
export function coercePlatform(value: string | undefined): ClientPlatform {
  return (KNOWN_PLATFORMS as readonly string[]).includes(value ?? "") ? (value as ClientPlatform) : "web";
}
