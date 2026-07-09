import { describe, expect, it } from "vitest";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import type { ResolvePort } from "@/lib/intelligence/crawl";
import { monitorProperty } from "./monitor";
import type { CrawlerAccessVerdict, PropertyMonitorReport } from "./types";

/**
 * M5 crawl→analyze WIRING, over the REAL reused crawl layer (crawlSite +
 * extract + egress guard + RENDER_VISIBLE_MIN_WORDS). Only the FetchPort and
 * the DNS resolver are scripted — zero live network, zero live DNS. Reuses the
 * shared ScriptedFetch harness + the crawl fixtures pattern.
 */

const ORIGIN = "https://example.com";
const CRAWLED_AT = "2026-07-09T00:00:00.000Z";

/** Public resolver answer so the SSRF egress guard passes for the scripted host. */
const publicResolve: ResolvePort = async () => [{ address: "93.184.216.34", family: 4 }];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

/** Content page with no scripts and > RENDER_VISIBLE_MIN_WORDS of text. */
function staticPage(): string {
  return `<!doctype html><html><head><title>GG Realty</title></head><body><h1>Advisory</h1><p>${"Real advisory copy ".repeat(20)}</p></body></html>`;
}

/** SPA shell: a mount div, bundles, and almost no server text → JS-dependent. */
function jsShellPage(): string {
  return `<!doctype html><html><head><title>App</title></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>`;
}

function scriptSite(opts: { robots: { status: number; body: string }; page: string }): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(opts.robots.status, opts.robots.body));
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () => htmlResponse(200, opts.page));
  return fetchPort;
}

function run(fetchPort: ScriptedFetch): Promise<PropertyMonitorReport> {
  return monitorProperty({ fetchPort: fetchPort.port, resolvePort: publicResolve, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
}

function verdict(report: PropertyMonitorReport, botId: string): CrawlerAccessVerdict {
  const v = report.crawlers.find((c) => c.botId === botId);
  if (!v) throw new Error(`no verdict for ${botId}`);
  return v;
}

describe("monitorProperty — render visibility over the real crawler", () => {
  it("a static, script-free page renders WITHOUT JS → visible, no render risk", async () => {
    const report = await run(scriptSite({ robots: { status: 404, body: "no" }, page: staticPage() }));
    expect(report.coverage.crawled).toBe(1);
    expect(report.render.pages[0]).toMatchObject({ url: `${ORIGIN}/`, status: "visible" });
    expect(report.hasRenderRisk).toBe(false);
  });

  it("an SPA shell (scripts + almost no server text) → js_dependent render RISK", async () => {
    const report = await run(scriptSite({ robots: { status: 404, body: "no" }, page: jsShellPage() }));
    expect(report.hasRenderRisk).toBe(true);
    expect(report.render.jsDependentUrls).toEqual([`${ORIGIN}/`]);
  });
});

describe("monitorProperty — crawler access over the real crawler", () => {
  it("robots blocking GPTBot only → GPTBot blocked, ClaudeBot allowed, page still crawled", async () => {
    // Blocks GPTBot but NOT our AEO-AuditBot, so the page is still crawled.
    const robots = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n";
    const report = await run(scriptSite({ robots: { status: 200, body: robots }, page: staticPage() }));
    expect(report.coverage.crawled).toBe(1);
    expect(verdict(report, "GPTBot").access).toBe("blocked");
    expect(verdict(report, "ClaudeBot").access).toBe("allowed");
    expect(report.blockedCrawlers).toEqual(["GPTBot"]);
  });

  it("a blanket `Disallow: /` blocks our crawler too — ZERO pages, yet a full crawler verdict (the M5 differentiator)", async () => {
    const report = await run(scriptSite({ robots: { status: 200, body: "User-agent: *\nDisallow: /\n" }, page: staticPage() }));
    // Our own crawler was blocked → nothing crawled...
    expect(report.coverage.crawled).toBe(0);
    // ...but robots.txt WAS read, so every AI crawler gets a real `blocked` verdict.
    expect(report.robotsTxtStatus).toBe("fetched");
    for (const c of report.crawlers) expect(c.access).toBe("blocked");
    // Render is honestly unknown (no HTML seen), never invisible.
    expect(report.render.jsDependentUrls).toEqual([]);
    expect(report.render.unknownCount).toBeGreaterThan(0);
  });

  it("UNREACHABLE robots.txt (503) → every crawler unknown, nothing crawled, nothing asserted", async () => {
    const report = await run(scriptSite({ robots: { status: 503, body: "boom" }, page: staticPage() }));
    expect(report.robotsTxtStatus).toBe("unreachable");
    for (const c of report.crawlers) expect(c.access).toBe("unknown");
    expect(report.blockedCrawlers).toEqual([]);
  });
});
