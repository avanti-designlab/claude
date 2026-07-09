import "server-only";

/**
 * M6 decay-scan — production wiring for the crawler's injected ports.
 *
 * Each intelligence module wires its own port seam (the audit engine has one
 * too) behind the same boundary its action tests `vi.mock`, so no test ever
 * touches live network or live DNS. This does NOT fork the crawl layer — it
 * hands the SAME `crawlSite` its ports:
 *  - `liveFetchPort()` wraps global `fetch`, adding the one thing the shared
 *    FetchPort contract can't express — a per-request timeout
 *    (`AbortSignal.timeout` with the crawl layer's own `REQUEST_TIMEOUT_MS`).
 *    `redirect: "error"` stays enforced per-request inside the crawler.
 *  - `liveResolvePort()` wraps `dns.lookup(host, { all: true })` so the crawl's
 *    SSRF egress guard sees every address a host resolves to (reuse, not fork).
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
