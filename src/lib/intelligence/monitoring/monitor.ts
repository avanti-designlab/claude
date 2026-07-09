/**
 * M5 Crawler + render-visibility monitor — crawl + analyze (doc 05 M5, doc 07 §1.4).
 *
 * `monitorProperty` is the M5 core: crawl a property over the injected FetchPort
 * using the REUSED M2 crawl layer (`crawlSite` — same bounded, same-origin,
 * robots-respecting, SSRF-guarded crawler the audit uses; we do NOT fork it),
 * then hand its `CrawlResult` to the pure `analyzeMonitor` for per-crawler
 * robots verdicts + per-page render verdicts.
 *
 * Why reuse `crawlSite` wholesale: its output already carries EVERY signal M5
 * needs — `site.robotsTxt` (+ `coverage.robotsTxtStatus` for the unreachable →
 * unknown honesty), and `page.rendersWithoutJs` (the raw-HTML render signal via
 * `RENDER_VISIBLE_MIN_WORDS`). The egress guard runs INSIDE `crawlSite` on every
 * fetch, so the SSRF closure holds for M5 with zero new fetch surface.
 *
 * ── NOTE — M5 does NOT gate on a zero-page crawl (unlike M2) ─────────────────
 * The audit refuses a zero-page crawl because a rubric SCORE from no pages is
 * meaningless. M5 is different: a robots.txt that blocks our own crawler yields
 * ZERO crawled pages yet a fully MEANINGFUL crawler-access verdict from the
 * served robots.txt (tested against the root path). So M5 always returns a
 * report; the root path is always tested. Render verdicts for the uncrawled
 * pages are honestly `unknown`.
 */

import { crawlSite, type CrawlBounds, type ResolvePort } from "@/lib/intelligence/crawl";
import type { FetchPort } from "@/lib/write-methods/shared";
import { analyzeMonitor } from "./analyze";
import type { PropertyMonitorReport } from "./types";

export interface MonitorPropertyInput {
  fetchPort: FetchPort;
  /**
   * Injected DNS resolver for the crawler's SSRF egress guard — REQUIRED
   * (production wires node dns behind the live-fetch seam; tests pass a fake).
   * Passed straight through to `crawlSite`; M5 never resolves DNS itself.
   */
  resolvePort: ResolvePort;
  /** Absolute http(s) URL of the property (callers validate before invoking). */
  startUrl: string;
  /** ISO timestamp for the crawl — caller-supplied (determinism). */
  crawledAt: string;
  bounds?: Partial<CrawlBounds>;
}

export async function monitorProperty(input: MonitorPropertyInput): Promise<PropertyMonitorReport> {
  const crawl = await crawlSite({
    fetchPort: input.fetchPort,
    resolvePort: input.resolvePort,
    startUrl: input.startUrl,
    crawledAt: input.crawledAt,
    bounds: input.bounds,
  });
  return analyzeMonitor(crawl);
}
