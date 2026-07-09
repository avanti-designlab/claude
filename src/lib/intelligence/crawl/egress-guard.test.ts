/**
 * SSRF egress-guard unit suite (Code Review 9e83459 MAJOR — CLOSE THE CLASS).
 *
 * Pins the pure classifier directly so every blocked range is covered even
 * where the crawler tests don't reach it, and — just as important — proves the
 * guard does NOT over-block real public addresses (no false positives that
 * would silently break legitimate audits). Also pins the async DNS path's
 * fail-closed and any-blocked-wins semantics over an injected fake resolver.
 */

import { describe, expect, it } from "vitest";
import { checkEgressHost, hostIsBlockedLiteral, isBlockedAddress, type ResolvePort } from "./egress-guard";

describe("isBlockedAddress — IPv4 ranges", () => {
  it("blocks every non-public IPv4 range", () => {
    for (const ip of [
      "0.0.0.0", // unspecified / this-network
      "0.1.2.3", // 0.0.0.0/8
      "10.0.0.5", // RFC1918
      "10.255.255.255",
      "100.64.0.1", // CGNAT
      "100.127.255.255",
      "127.0.0.1", // loopback
      "127.99.1.2",
      "169.254.169.254", // link-local / cloud metadata
      "172.16.0.1", // RFC1918
      "172.31.255.255",
      "192.168.0.1", // RFC1918
      "198.18.0.7", // benchmarking
      "224.0.0.1", // multicast
      "240.0.0.1", // reserved
      "255.255.255.255", // broadcast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("does NOT block real public IPv4 (no false positives)", () => {
    for (const ip of [
      "93.184.216.34", // example.com
      "8.8.8.8",
      "1.1.1.1",
      "172.15.255.255", // just below 172.16/12
      "172.32.0.1", // just above 172.16/12
      "100.63.255.255", // just below CGNAT
      "100.128.0.0", // just above CGNAT
      "11.0.0.1", // just above 10/8
      "126.255.255.255", // just below loopback
      "128.0.0.1", // just above loopback
      "169.253.255.255", // just below link-local
      "169.255.0.0", // just above link-local
      "223.255.255.255", // just below multicast
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("isBlockedAddress — IPv6 ranges (incl. embedded IPv4)", () => {
  it("blocks non-public IPv6", () => {
    for (const ip of [
      "::1", // loopback
      "::", // unspecified
      "fe80::1", // link-local
      "febf:ffff::1", // top of fe80::/10
      "fc00::1", // ULA
      "fd12:3456::1", // ULA
      "ff02::1", // multicast
      "::ffff:10.0.0.1", // IPv4-mapped → private v4
      "::ffff:127.0.0.1", // IPv4-mapped → loopback
      "::ffff:169.254.169.254", // IPv4-mapped → metadata
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("does NOT block real public IPv6", () => {
    for (const ip of [
      "2606:4700:4700::1111", // cloudflare
      "2001:4860:4860::8888", // google
      "::ffff:93.184.216.34", // IPv4-mapped → PUBLIC v4 stays public
      "fec0::1", // deprecated site-local, NOT in fe80::/10 or fc00::/7
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });

  it("fails closed on an unparseable address", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("")).toBe(true);
  });
});

describe("hostIsBlockedLiteral — synchronous, pre-DNS", () => {
  it("blocks IP literals in blocked ranges and the localhost name (incl. bracketed IPv6)", () => {
    for (const host of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "[::1]", "localhost", "app.localhost", ""]) {
      expect(hostIsBlockedLiteral(host), host).toBe(true);
    }
  });

  it("returns false for public IP literals AND for DNS hostnames (those need the resolve path)", () => {
    for (const host of ["93.184.216.34", "[2606:4700::1111]", "example.com", "sub.example.co.uk"]) {
      expect(hostIsBlockedLiteral(host), host).toBe(false);
    }
  });
});

describe("checkEgressHost — the async DNS-resolving verdict", () => {
  const neverCalled: ResolvePort = async () => {
    throw new Error("resolver must not be called");
  };

  it("blocks literal/localhost hosts WITHOUT calling the resolver", async () => {
    expect(await checkEgressHost("127.0.0.1", neverCalled)).toBe(false);
    expect(await checkEgressHost("localhost", neverCalled)).toBe(false);
    expect(await checkEgressHost("[::1]", neverCalled)).toBe(false);
  });

  it("allows a public IP literal WITHOUT calling the resolver", async () => {
    expect(await checkEgressHost("93.184.216.34", neverCalled)).toBe(true);
    expect(await checkEgressHost("[2606:4700::1111]", neverCalled)).toBe(true);
  });

  it("resolves a DNS hostname and allows it only when EVERY address is public", async () => {
    const allPublic: ResolvePort = async () => [{ address: "93.184.216.34" }, { address: "2606:4700::1111" }];
    expect(await checkEgressHost("example.com", allPublic)).toBe(true);
  });

  it("blocks when ANY resolved address is internal (rebinding to a private range)", async () => {
    const oneBad: ResolvePort = async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }];
    expect(await checkEgressHost("rebind.example", oneBad)).toBe(false);
  });

  it("fails closed on a resolver throw or an empty answer", async () => {
    const throws: ResolvePort = async () => {
      throw new Error("dns failure");
    };
    const empty: ResolvePort = async () => [];
    expect(await checkEgressHost("nxdomain.example", throws)).toBe(false);
    expect(await checkEgressHost("noaddr.example", empty)).toBe(false);
  });
});
