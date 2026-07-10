import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { makePinnedLookup, vetResolvedAddresses, type PinnedLookupOptions } from "./pin-lookup";

const PUBLIC_V4: LookupAddress = { address: "93.184.216.34", family: 4 };
const PUBLIC_V6: LookupAddress = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };
const LOOPBACK: LookupAddress = { address: "127.0.0.1", family: 4 };
const METADATA: LookupAddress = { address: "169.254.169.254", family: 4 };
const RFC1918: LookupAddress = { address: "10.0.0.5", family: 4 };
const V6_LOOPBACK: LookupAddress = { address: "::1", family: 6 };

describe("vetResolvedAddresses (any-blocked-wins, fail closed)", () => {
  it("accepts an all-public answer", () => {
    expect(vetResolvedAddresses([PUBLIC_V4]).ok).toBe(true);
  });
  it("rejects loopback / metadata / RFC1918 / IPv6 loopback", () => {
    expect(vetResolvedAddresses([LOOPBACK]).ok).toBe(false);
    expect(vetResolvedAddresses([METADATA]).ok).toBe(false);
    expect(vetResolvedAddresses([RFC1918]).ok).toBe(false);
    expect(vetResolvedAddresses([V6_LOOPBACK]).ok).toBe(false);
  });
  it("rejects a MIXED answer (a public + an internal address) whole — the rebinding shape", () => {
    expect(vetResolvedAddresses([PUBLIC_V4, LOOPBACK]).ok).toBe(false);
  });
  it("rejects an empty answer", () => {
    expect(vetResolvedAddresses([]).ok).toBe(false);
  });
});

/** Drive the lookup and await its callback (it resolves asynchronously). */
function invoke(
  lookup: ReturnType<typeof makePinnedLookup>,
  hostname: string,
  options: PinnedLookupOptions
): Promise<{ err: NodeJS.ErrnoException | null; address?: string | LookupAddress[]; family?: number }> {
  return new Promise((resolve) => {
    lookup(hostname, options, (err, address, family) => resolve({ err, address, family }));
  });
}

describe("makePinnedLookup (the socket-pinning connector lookup)", () => {
  it("pins the socket to the vetted address (single form) for a public host", async () => {
    const lookup = makePinnedLookup(async () => [PUBLIC_V4]);
    const { err, address, family } = await invoke(lookup, "example.com", {});
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });

  it("returns the vetted array when undici asks for all (Happy Eyeballs)", async () => {
    const lookup = makePinnedLookup(async () => [PUBLIC_V4, PUBLIC_V6]);
    const { err, address } = await invoke(lookup, "example.com", { all: true });
    expect(err).toBeNull();
    expect(address).toEqual([PUBLIC_V4, PUBLIC_V6]);
  });

  it("REFUSES (errors, no address) when the host resolves to an internal address — closes the TOCTOU", async () => {
    const lookup = makePinnedLookup(async () => [LOOPBACK]);
    const { err, address } = await invoke(lookup, "rebind.evil", {});
    expect(err).not.toBeNull();
    expect(address).toBeUndefined();
  });

  it("REFUSES a mixed answer (rebinding: one public + one internal)", async () => {
    const lookup = makePinnedLookup(async () => [PUBLIC_V4, METADATA]);
    const { err } = await invoke(lookup, "rebind.evil", { all: true });
    expect(err).not.toBeNull();
  });

  it("REFUSES (fail closed) when the resolver throws", async () => {
    const lookup = makePinnedLookup(async () => {
      throw new Error("SERVFAIL");
    });
    const { err } = await invoke(lookup, "nx.example", {});
    expect(err).not.toBeNull();
  });

  it("filters by requested family and refuses when none vetted for it", async () => {
    const lookup = makePinnedLookup(async () => [PUBLIC_V4]); // only v4 available
    const ok4 = await invoke(lookup, "example.com", { family: 4 });
    expect(ok4.err).toBeNull();
    expect(ok4.address).toBe("93.184.216.34");
    const no6 = await invoke(lookup, "example.com", { family: 6 });
    expect(no6.err).not.toBeNull();
  });
});
