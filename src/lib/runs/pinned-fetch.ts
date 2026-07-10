import "server-only";

/**
 * A7 — the DNS-rebinding socket-pinning closure, landing at the processor's
 * live-fetch wiring (ARCHITECTURE RULING amendment A7; closes the residual the
 * egress guard names in crawl/egress-guard.ts). This file is the thin, live-only
 * undici SHELL; the security-critical vetting/pinning logic is the pure,
 * unit-tested `pin-lookup.ts`.
 *
 * THE HOLE THIS CLOSES. `checkEgressHost` (crawl/egress-guard.ts) resolves a
 * host and vets every address, but the crawler's fetch then resolves the host
 * AGAIN to open the socket — two lookups. A hostile authoritative server can
 * answer "public" for the check and "127.0.0.1" for the connect (short-TTL
 * rebinding), keeping a narrow time-of-check/time-of-use window open to an
 * internal target. The egress guard documents the fix as "an undici custom
 * lookup/dispatcher that hands the socket the vetted address" — that is exactly
 * this module.
 *
 * HOW IT CLOSES IT. The processor's live fetch runs on an undici `Agent` whose
 * connector `lookup` IS the vetting step (makePinnedLookup). undici calls this
 * lookup ONCE per connection and connects the socket to precisely the address it
 * returns — so the address we vet IS the address the socket connects to (no
 * second resolution). TLS is unaffected: undici sets `servername` from the URL
 * host, so certificate verification still matches the hostname while the TCP
 * socket lands on the vetted IP.
 *
 * SCOPE. Wires the REAL fetch + REAL DNS with socket pinning — the in-scope A7
 * live wiring. Imports `isBlockedAddress` from the egress guard (import only —
 * crawl/** internals are another agent's surface and are NOT modified). Calls NO
 * vendor API.
 */

import { lookup as nodeLookup, type LookupAddress } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import { REQUEST_TIMEOUT_MS } from "@/lib/intelligence/crawl";
import type { FetchPort, FetchPortResponse } from "@/lib/write-methods/shared";
import { makePinnedLookup, type ResolveAllPort } from "./pin-lookup";

/** Live node DNS resolver ({all:true}) behind the pinned-lookup seam. */
const liveResolveAll: ResolveAllPort = (hostname) =>
  new Promise<LookupAddress[]>((resolve, reject) =>
    nodeLookup(hostname, { all: true }, (err, addresses) =>
      err ? reject(err) : resolve(addresses)
    )
  );

/** A per-run pinned fetch: the port plus a disposer for its undici Agent. */
export interface PinnedFetch {
  port: FetchPort;
  /** Close the Agent's pooled connections once the run is done (hygiene — a
   *  leaked agent only holds idle sockets, but the runtime is long-lived). */
  close(): Promise<void>;
}

/**
 * The processor's live, socket-pinned FetchPort. One undici Agent per call site
 * (per run) pools connections whose sockets are pinned to vetted addresses by
 * the connector lookup. A per-request timeout mirrors the audit crawler's
 * live-fetch seam; `redirect: "error"` rides through from the caller's init.
 * Callers MUST `close()` when the run completes (live.ts does, in its
 * completion path).
 */
export function pinnedFetchPort(): PinnedFetch {
  const agent = new Agent({
    // The connector `lookup` follows node's dns.lookup contract (undici passes
    // it straight to net/tls connect); our PinnedLookup handles both the
    // all:true array form and the single form, so the cast is safe.
    connect: { lookup: makePinnedLookup(liveResolveAll) as unknown as LookupFunction },
  });
  return {
    port: async (url, init) => {
      const res = await undiciFetch(url, {
        ...init,
        dispatcher: agent,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      return res as unknown as FetchPortResponse;
    },
    close: async () => {
      try {
        await agent.close();
      } catch {
        /* disposal is hygiene only — never let it affect the run outcome */
      }
    },
  };
}
