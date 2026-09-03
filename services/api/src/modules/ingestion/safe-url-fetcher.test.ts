import { describe, expect, it } from "vitest";
import { isPrivateOrReservedIp } from "./safe-url-fetcher";

describe("isPrivateOrReservedIp — SSRF guard", () => {
  it("blocks loopback", () => {
    expect(isPrivateOrReservedIp("127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("127.1.2.3")).toBe(true);
    expect(isPrivateOrReservedIp("::1")).toBe(true);
  });

  it("blocks the cloud instance-metadata address", () => {
    expect(isPrivateOrReservedIp("169.254.169.254")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    expect(isPrivateOrReservedIp("10.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("10.255.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("172.16.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("172.31.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.168.255.255")).toBe(true);
  });

  it("does not block addresses adjacent to but outside a private range", () => {
    expect(isPrivateOrReservedIp("172.15.255.255")).toBe(false); // just below 172.16.0.0/12
    expect(isPrivateOrReservedIp("172.32.0.0")).toBe(false); // just above it
    expect(isPrivateOrReservedIp("11.0.0.1")).toBe(false); // outside 10.0.0.0/8
  });

  it("blocks CGNAT, benchmarking, and documentation/test ranges", () => {
    expect(isPrivateOrReservedIp("100.64.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("198.18.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("192.0.2.1")).toBe(true);
    expect(isPrivateOrReservedIp("198.51.100.1")).toBe(true);
    expect(isPrivateOrReservedIp("203.0.113.1")).toBe(true);
  });

  it("blocks multicast, broadcast, and 0.0.0.0/8", () => {
    expect(isPrivateOrReservedIp("224.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("255.255.255.255")).toBe(true);
    expect(isPrivateOrReservedIp("0.0.0.0")).toBe(true);
  });

  it("blocks IPv6 unique-local and link-local", () => {
    expect(isPrivateOrReservedIp("fc00::1")).toBe(true);
    expect(isPrivateOrReservedIp("fd12:3456::1")).toBe(true);
    expect(isPrivateOrReservedIp("fe80::1")).toBe(true);
  });

  it("blocks an IPv4-mapped IPv6 address whose embedded IPv4 is private", () => {
    expect(isPrivateOrReservedIp("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateOrReservedIp("::ffff:10.0.0.1")).toBe(true);
  });

  it("allows a real public IPv4 address", () => {
    expect(isPrivateOrReservedIp("8.8.8.8")).toBe(false);
    expect(isPrivateOrReservedIp("1.1.1.1")).toBe(false);
    expect(isPrivateOrReservedIp("93.184.216.34")).toBe(false);
  });

  it("allows a real public IPv6 address", () => {
    expect(isPrivateOrReservedIp("2606:4700:4700::1111")).toBe(false); // Cloudflare DNS
  });

  it("fails closed on a malformed address", () => {
    expect(isPrivateOrReservedIp("not-an-ip")).toBe(true);
    expect(isPrivateOrReservedIp("999.999.999.999")).toBe(true);
  });
});
