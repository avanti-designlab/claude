import "server-only";

/**
 * Production wiring for the audit crawler's injected ports — the platform
 * `fetch` and node DNS, behind the same seam the action tests vi.mock so no
 * test ever touches live network or live DNS.
 *
 *  - `liveFetchPort()` returns a FetchPort backed by global `fetch`, adding the
 *    ONE thing the crawler cannot express through the shared port contract: a
 *    per-request timeout (`AbortSignal.timeout`). The FetchPortInit type
 *    (src/lib/write-methods/shared — out of this module's scope) carries no
 *    signal, so the bound is applied here, where the real socket lives. Without
 *    it a single hung request would ride undici's ~300s default. `redirect:
 *    "error"` stays enforced per-request by the crawler.
 *  - `liveResolvePort()` returns a ResolvePort backed by
 *    `dns.promises.lookup(host, { all: true })` — every address a host resolves
 *    to, so the SSRF egress guard can reject a host that resolves to ANY
 *    internal address (not just the first).
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
