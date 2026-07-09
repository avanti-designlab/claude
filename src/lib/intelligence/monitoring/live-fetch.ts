import "server-only";

/**
 * Production wiring for the M5 monitor's injected ports — the platform `fetch`
 * and node DNS, behind the same seam the action tests mock so no test ever
 * touches live network or live DNS. Mirrors src/lib/intelligence/audit/live-fetch.ts
 * (each intelligence module owns its own production port wiring; the crawler +
 * egress guard are the shared, reused seam).
 *
 *  - `liveFetchPort()` backs a FetchPort with global `fetch`, adding the one
 *    thing the crawler cannot express through the shared port contract: a
 *    per-request timeout (`AbortSignal.timeout`; the FetchPortInit type carries
 *    no signal). `redirect: "error"` stays enforced per-request by the crawler.
 *  - `liveResolvePort()` backs a ResolvePort with `dns.promises.lookup(host,
 *    { all: true })` — every address a host resolves to, so the SSRF egress
 *    guard can reject a host that resolves to ANY internal address.
 */

import { lookup } from "node:dns/promises";
import type { ResolvePort } from "@/lib/intelligence/crawl";
import { REQUEST_TIMEOUT_MS } from "@/lib/intelligence/crawl";
import type { FetchPort } from "@/lib/write-methods/shared";

export function liveFetchPort(): FetchPort {
  return (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

export function liveResolvePort(): ResolvePort {
  return async (hostname) => {
    const results = await lookup(hostname, { all: true });
    return results.map((r) => ({ address: r.address, family: r.family }));
  };
}
