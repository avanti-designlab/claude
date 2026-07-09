/**
 * M5 test fixtures — hand-built `CrawlResult`s for the PURE analyzers
 * (robots-access / render-visibility / analyze / rows). Mirrors the aeo-audit
 * skill's `fixtures.ts` precedent: a non-test builder imported only by tests,
 * so the pure decision surface is exercised with zero network. The
 * crawl→analyze WIRING (real `crawlSite`) is covered separately in monitor.test.ts.
 */

import type { CrawledPage } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage, CrawlResult, PageFailureReason, PageOutcome } from "@/lib/intelligence/crawl";

export const FIX_BASE_URL = "https://example.com";
export const FIX_CRAWLED_AT = "2026-07-09T00:00:00.000Z";

function page(url: string, rendersWithoutJs: boolean): CrawledPage {
  return {
    url,
    title: "Page",
    metaDescription: null,
    h1s: [],
    visibleText: rendersWithoutJs ? "Real content ".repeat(20) : "",
    jsonLdBlocks: [],
    images: [],
    internalLinks: [],
    hasVideo: false,
    hasTranscript: false,
    lastModified: null,
    rendersWithoutJs,
  };
}

function crawledOutcome(url: string): PageOutcome {
  return { url, depth: 0, status: "crawled", httpStatus: 200, detail: "Crawled." };
}

function failedOutcome(url: string, reason: PageFailureReason): PageOutcome {
  return { url, depth: 0, status: "failed", reason, detail: `Failed: ${reason}.` };
}

export interface MakeCrawlOpts {
  baseUrl?: string;
  crawledAt?: string;
  robotsTxt?: string | null;
  robotsTxtStatus?: CrawlCoverage["robotsTxtStatus"];
  llmsTxtStatus?: CrawlCoverage["llmsTxtStatus"];
  /** Successfully-crawled pages: [url, rendersWithoutJs]. */
  pages?: Array<[url: string, rendersWithoutJs: boolean]>;
  /** Pages that failed to crawl: [url, reason]. */
  failed?: Array<[url: string, reason: PageFailureReason]>;
  frontierTruncated?: boolean;
  offOriginRefused?: number;
}

/** Build a `CrawlResult` for the pure analyzers. Robots content defaults to null. */
export function makeCrawlResult(opts: MakeCrawlOpts = {}): CrawlResult {
  const baseUrl = opts.baseUrl ?? FIX_BASE_URL;
  const crawledAt = opts.crawledAt ?? FIX_CRAWLED_AT;
  const robotsTxtStatus = opts.robotsTxtStatus ?? (opts.robotsTxt != null ? "fetched" : "absent");
  const robotsTxt = robotsTxtStatus === "fetched" ? (opts.robotsTxt ?? "") : null;

  const pageSpecs = opts.pages ?? [];
  const failedSpecs = opts.failed ?? [];
  const pages: CrawledPage[] = pageSpecs.map(([url, renders]) => page(url, renders));
  const outcomes: PageOutcome[] = [
    ...pageSpecs.map(([url]) => crawledOutcome(url)),
    ...failedSpecs.map(([url, reason]) => failedOutcome(url, reason)),
  ];

  const coverage: CrawlCoverage = {
    attempted: outcomes.length,
    crawled: pages.length,
    pages: outcomes,
    robotsTxtStatus,
    llmsTxtStatus: opts.llmsTxtStatus ?? "absent",
    frontierTruncated: opts.frontierTruncated ?? false,
    offOriginRefused: opts.offOriginRefused ?? 0,
  };

  return {
    site: { baseUrl, crawledAt, pages, robotsTxt, llmsTxt: null },
    coverage,
  };
}
