/**
 * M5 — pure analyzer: `CrawlResult` → `PropertyMonitorReport` (doc 05 M5).
 *
 * This is the M5 core, and it is PURE: no fetch, no clock, no DB. It takes the
 * reused M2 crawl layer's output and composes the per-crawler robots verdicts
 * (robots-access.ts) with the per-page render verdicts (render-visibility.ts)
 * into one property report, plus the roll-ups alerting/dashboard read. Keeping
 * it fetch-free means the whole decision surface is unit-tested against
 * hand-built crawl results with zero network — the orchestrator (monitor.ts)
 * only wires `crawlSite` in front of it.
 *
 * Determinism: given the same `CrawlResult` the report is byte-identical.
 */

import type { CrawlResult } from "@/lib/intelligence/crawl";
import { evaluateCrawlerAccess } from "./robots-access";
import { evaluateRenderVisibility } from "./render-visibility";
import type { PropertyMonitorReport } from "./types";

export function analyzeMonitor(crawl: CrawlResult): PropertyMonitorReport {
  const crawlers = evaluateCrawlerAccess(crawl);
  const render = evaluateRenderVisibility(crawl);

  const blockedCrawlers = crawlers
    .filter((verdict) => verdict.access === "blocked")
    .map((verdict) => verdict.botId)
    .sort();
  const unknownCrawlers = crawlers
    .filter((verdict) => verdict.access === "unknown")
    .map((verdict) => verdict.botId)
    .sort();

  return {
    baseUrl: crawl.site.baseUrl,
    crawledAt: crawl.site.crawledAt,
    robotsTxtStatus: crawl.coverage.robotsTxtStatus,
    llmsTxtStatus: crawl.coverage.llmsTxtStatus,
    crawlers,
    render,
    coverage: crawl.coverage,
    blockedCrawlers,
    unknownCrawlers,
    hasCrawlerBlock: blockedCrawlers.length > 0,
    hasRenderRisk: render.jsDependentCount > 0,
  };
}
