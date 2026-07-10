/**
 * A7 socket-pinning — the PURE, unit-tested core (the security-critical half of
 * the DNS-rebinding closure). Kept out of the server-only undici shell
 * (pinned-fetch.ts) so the vetting + pinning logic is exercised with a fake
 * resolver and a captured callback in the default `npm test` run — no network,
 * no undici.
 *
 * The closure (see pinned-fetch.ts header): undici calls `makePinnedLookup`'s
 * result ONCE per connection and connects the socket to exactly the address it
 * returns, so the address vetted here IS the address connected. This module
 * decides which addresses are safe (any-blocked-wins, fail closed) and hands the
 * socket a vetted one.
 */

import type { LookupAddress } from "node:dns";
import { isBlockedAddress } from "@/lib/intelligence/crawl";

/** All addresses a host resolves to (node dns.lookup {all:true} shape). */
export type ResolveAllPort = (hostname: string) => Promise<LookupAddress[]>;

/** node dns.lookup callback (unifies the all:true array form and single form). */
export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number
) => void;
export type PinnedLookupOptions = { family?: number; all?: boolean; [key: string]: unknown };

/** The connector `lookup` undici (via net/tls connect) invokes per connection. */
export type PinnedLookup = (
  hostname: string,
  options: PinnedLookupOptions,
  callback: LookupCallback
) => void;

/** Opaque refusal — surfaces as a plain connect failure (crawler records
 *  `fetch_failed`), never a status/leak oracle (matches the guard's posture). */
export function egressRefusal(reason: string): NodeJS.ErrnoException {
  const err = new Error(`egress-guard: connection refused (${reason})`) as NodeJS.ErrnoException;
  err.code = "EAI_FAIL";
  return err;
}

export interface VetResult {
  ok: boolean;
  addresses: LookupAddress[];
}

/**
 * Vet a resolver answer: reject (fail closed) on empty, malformed, or ANY
 * blocked address — the exact any-blocked-wins rule checkEgressHost uses, so a
 * host resolving to a mix of public and internal addresses is refused whole.
 */
export function vetResolvedAddresses(addresses: LookupAddress[]): VetResult {
  if (!Array.isArray(addresses) || addresses.length === 0) return { ok: false, addresses: [] };
  for (const entry of addresses) {
    if (typeof entry?.address !== "string" || isBlockedAddress(entry.address)) {
      return { ok: false, addresses: [] };
    }
  }
  return { ok: true, addresses };
}

/**
 * Build the socket-pinning lookup from an injected resolver. The vetting +
 * pinning behaviour is exercised with a fake resolver + captured callback (no
 * network); production passes the node dns resolver (pinned-fetch.ts).
 */
export function makePinnedLookup(resolveAll: ResolveAllPort): PinnedLookup {
  return (hostname, options, callback) => {
    resolveAll(hostname)
      .then((addresses) => {
        const vet = vetResolvedAddresses(addresses);
        if (!vet.ok) {
          callback(egressRefusal("resolved to a blocked/empty address"));
          return;
        }
        let vetted = vet.addresses;
        const family = options?.family;
        if (family === 4 || family === 6) vetted = vetted.filter((address) => address.family === family);
        if (vetted.length === 0) {
          callback(egressRefusal("no vetted address for requested family"));
          return;
        }
        // Pin: hand the socket a vetted address (array form when undici asked for
        // all, single form otherwise). Every returned address is already vetted,
        // so whichever undici connects to is safe.
        if (options?.all) callback(null, vetted);
        else callback(null, vetted[0].address, vetted[0].family);
      })
      .catch(() => callback(egressRefusal("resolve failed")));
  };
}
