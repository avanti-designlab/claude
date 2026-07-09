import { describe, expect, it } from "vitest";
import { analyzeMonitor } from "./analyze";
import { makeCrawlResult, FIX_BASE_URL, FIX_CRAWLED_AT } from "./fixtures";

describe("analyzeMonitor — composition + roll-ups", () => {
  it("carries crawl metadata + coverage through unchanged", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxt: "", pages: [[`${FIX_BASE_URL}/a`, true]] }));
    expect(report.baseUrl).toBe(FIX_BASE_URL);
    expect(report.crawledAt).toBe(FIX_CRAWLED_AT);
    expect(report.robotsTxtStatus).toBe("fetched");
    expect(report.coverage.crawled).toBe(1);
  });

  it("a clean site: no block, no render risk", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxt: "", pages: [[`${FIX_BASE_URL}/a`, true]] }));
    expect(report.hasCrawlerBlock).toBe(false);
    expect(report.hasRenderRisk).toBe(false);
    expect(report.blockedCrawlers).toEqual([]);
  });

  it("blockedCrawlers is the sorted set of blocked botIds; render risk is flagged", () => {
    const robotsTxt = "User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /\n";
    const report = analyzeMonitor(makeCrawlResult({ robotsTxt, pages: [[`${FIX_BASE_URL}/a`, false]] }));
    expect(report.hasCrawlerBlock).toBe(true);
    expect(report.blockedCrawlers).toEqual(["GPTBot", "PerplexityBot"]); // sorted
    expect(report.hasRenderRisk).toBe(true);
    expect(report.render.jsDependentUrls).toEqual([`${FIX_BASE_URL}/a`]);
  });

  it("unreachable robots.txt: every crawler is unknown (surfaced, not blocked)", () => {
    const report = analyzeMonitor(makeCrawlResult({ robotsTxtStatus: "unreachable" }));
    expect(report.hasCrawlerBlock).toBe(false);
    expect(report.blockedCrawlers).toEqual([]);
    expect(report.unknownCrawlers.length).toBe(report.crawlers.length);
  });
});
