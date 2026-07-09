/**
 * Crawler suite (M2 crawl layer): every hard rule pinned — page/depth/byte
 * caps, off-origin refusal, robots respect (including unreachable robots),
 * redirect/error honesty, URL dedup, and byte-identical determinism. All runs
 * go through the shared ScriptedFetch harness — zero live network, and an
 * UNSCRIPTED request throws, so "the crawler never fetched X" is proven by
 * the run completing at all, then re-asserted against the request journal.
 */

import { describe, expect, it } from "vitest";
import { htmlResponse, jsonResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import { crawlSite } from "./crawler";
import { AUDIT_CRAWLER_USER_AGENT } from "./types";

const ORIGIN = "https://site.test";
const CRAWLED_AT = "2026-07-01T00:00:00.000Z";

/** Anchor a route to one exact URL (substring matching would over-match "/"). */
function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

const ROBOTS_ALLOW_ALL = "User-agent: *\nAllow: /\n";

/** A small, healthy two-page site plus assorted hostile links off the home page. */
function scriptHealthySite(): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () =>
    textResponse(200, "User-agent: AEO-AuditBot\nDisallow: /private\n\nUser-agent: *\nAllow: /\n"),
  );
  fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(200, "# site.test\n- [About](/about)\n"));
  fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
    htmlResponse(
      200,
      `<title>Home</title><h1>Home</h1>
       <p>${"Substantive home-page copy answering real questions. ".repeat(3)}</p>
       <a href="/about">about</a>
       <a href="/about/">about-again</a>
       <a href="/about#team">about-anchor</a>
       <a href="/about?utm=x">about-tracked</a>
       <a href="/private">private</a>
       <a href="https://evil.test/steal">off-origin</a>
       <a href="//evil2.test/steal">protocol-relative off-origin</a>
       <a href="http://site.test/downgrade">scheme change = different origin</a>
       <a href="https://sub.site.test/">subdomain = different origin</a>
       <a href="mailto:x@site.test">mail</a>
       <a href="javascript:alert(1)">js</a>`,
    ),
  );
  fetchPort.on("GET", exact(`${ORIGIN}/about`), () =>
    htmlResponse(
      200,
      `<title>About</title><h1>About</h1>
       <p>${"Substantive about-page copy describing the team and services. ".repeat(3)}</p>
       <a href="/">home</a>`,
    ),
  );
  return fetchPort;
}

describe("crawlSite — happy path, dedup, and the skill-input shape", () => {
  it("crawls same-origin pages breadth-first and fills the aeo-audit CrawledSite contract", async () => {
    const fetchPort = scriptHealthySite();
    const { site, coverage } = await crawlSite({
      fetchPort: fetchPort.port,
      startUrl: ORIGIN,
      crawledAt: CRAWLED_AT,
    });

    expect(site.baseUrl).toBe(ORIGIN);
    expect(site.crawledAt).toBe(CRAWLED_AT);
    expect(site.robotsTxt).toContain("AEO-AuditBot");
    expect(site.llmsTxt).toContain("# site.test");
    expect(site.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/about`]);

    const home = site.pages[0];
    expect(home.title).toBe("Home");
    expect(home.h1s).toEqual(["Home"]);
    // Internal links: normalized (query/hash dropped, trailing slash stripped),
    // deduplicated, same-origin only.
    expect(home.internalLinks).toEqual([`${ORIGIN}/about`, `${ORIGIN}/private`]);
    expect(home.rendersWithoutJs).toBe(true);

    expect(coverage.robotsTxtStatus).toBe("fetched");
    expect(coverage.llmsTxtStatus).toBe("fetched");
    expect(coverage.crawled).toBe(2);
    // /about fetched exactly ONCE despite four href variants of it.
    const aboutFetches = fetchPort.requests.filter((r) => r.url === `${ORIGIN}/about`);
    expect(aboutFetches).toHaveLength(1);
  });

  it("sends an honest bot User-Agent and pins redirect:'error' on every request", async () => {
    const fetchPort = scriptHealthySite();
    await crawlSite({ fetchPort: fetchPort.port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    expect(fetchPort.requests.length).toBeGreaterThan(0);
    for (const req of fetchPort.requests) {
      expect(req.method).toBe("GET");
      expect(req.headers["user-agent"]).toBe(AUDIT_CRAWLER_USER_AGENT);
      expect(req.redirect).toBe("error");
    }
  });

  it("is deterministic: identical scripted responses → byte-identical CrawlResult", async () => {
    const runA = await crawlSite({ fetchPort: scriptHealthySite().port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    const runB = await crawlSite({ fetchPort: scriptHealthySite().port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    expect(JSON.stringify(runA)).toBe(JSON.stringify(runB));
  });

  it("rejects a non-http(s) start URL outright", async () => {
    const fetchPort = new ScriptedFetch();
    for (const bad of ["not a url", "ftp://site.test", "javascript:alert(1)"]) {
      await expect(crawlSite({ fetchPort: fetchPort.port, startUrl: bad, crawledAt: CRAWLED_AT })).rejects.toThrow(
        /absolute http\(s\) URL/,
      );
    }
    expect(fetchPort.requests).toEqual([]);
  });
});

describe("crawlSite — off-origin refusal (never fetched, honestly counted)", () => {
  it("refuses off-origin, subdomain, and scheme-changed links — the journal shows only same-origin fetches", async () => {
    const fetchPort = scriptHealthySite();
    // NOTE: evil.test / evil2.test / sub.site.test / http://site.test are NOT
    // scripted — if the crawler ever fetched one, ScriptedFetch would throw
    // and this test would fail loudly.
    const { coverage } = await crawlSite({ fetchPort: fetchPort.port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    for (const req of fetchPort.requests) {
      expect(req.url.startsWith(`${ORIGIN}/`)).toBe(true);
    }
    // evil.test, evil2.test, http://site.test, sub.site.test — all refused.
    expect(coverage.offOriginRefused).toBe(4);
  });
});

describe("crawlSite — robots.txt respect", () => {
  it("honors a path block for AEO-AuditBot: recorded, never fetched", async () => {
    const fetchPort = scriptHealthySite();
    const { site, coverage } = await crawlSite({ fetchPort: fetchPort.port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    const blocked = coverage.pages.find((p) => p.url === `${ORIGIN}/private`);
    expect(blocked).toMatchObject({ status: "failed", reason: "robots_disallowed" });
    expect(fetchPort.requests.some((r) => r.url.includes("/private"))).toBe(false);
    // The blocked page is NOT in the scored site — the skill never sees data
    // we did not actually read.
    expect(site.pages.some((p) => p.url.includes("/private"))).toBe(false);
  });

  it("robots.txt 404 = no robots served: everything is allowed, status 'absent'", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(404, "not found"));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "not found"));
    fetchPort.on("GET", exact(`${ORIGIN}/`), () => htmlResponse(200, `<title>t</title><p>body text</p>`));
    const { site, coverage } = await crawlSite({ fetchPort: fetchPort.port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    expect(coverage.robotsTxtStatus).toBe("absent");
    expect(coverage.llmsTxtStatus).toBe("absent");
    expect(site.robotsTxt).toBeNull();
    expect(site.llmsTxt).toBeNull();
    expect(coverage.crawled).toBe(1);
  });

  it("robots.txt unreachable (5xx): crawl rules unknown → NOTHING is fetched, said per-page", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(503, "boom"));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "not found"));
    // The start page is deliberately NOT scripted: fetching it would throw.
    const { site, coverage } = await crawlSite({ fetchPort: fetchPort.port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    expect(coverage.robotsTxtStatus).toBe("unreachable");
    expect(coverage.crawled).toBe(0);
    expect(coverage.pages).toEqual([
      expect.objectContaining({ url: `${ORIGIN}/`, status: "failed", reason: "robots_unavailable" }),
    ]);
    expect(site.pages).toEqual([]);
  });
});

describe("crawlSite — per-page failure honesty (redirects, errors, size, media type)", () => {
  function scriptFailureSite(): ScriptedFetch {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, ROBOTS_ALLOW_ALL));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
    fetchPort.on("GET", exact(`${ORIGIN}/`), () =>
      htmlResponse(
        200,
        `<title>Home</title><p>home body</p>
         <a href="/gone">gone</a><a href="/redirecty">redirecty</a>
         <a href="/huge">huge</a><a href="/pdf">pdf</a>`,
      ),
    );
    fetchPort.on("GET", exact(`${ORIGIN}/gone`), () => htmlResponse(404, "<title>404</title>"));
    fetchPort.on("GET", exact(`${ORIGIN}/redirecty`), () => {
      // WHATWG redirect:"error" semantics — the port REJECTS on a redirect.
      throw new TypeError("Failed to fetch: redirect mode is 'error'");
    });
    fetchPort.on("GET", exact(`${ORIGIN}/huge`), () =>
      jsonResponse(200, {}, { "content-length": "99999999", "content-type": "text/html" }),
    );
    fetchPort.on("GET", exact(`${ORIGIN}/pdf`), () => textResponse(200, "%PDF-1.7", "application/pdf"));
    return fetchPort;
  }

  it("records http_error / fetch_failed / too_large / not_html per page — nothing silently dropped", async () => {
    const { site, coverage } = await crawlSite({
      fetchPort: scriptFailureSite().port,
      startUrl: ORIGIN,
      crawledAt: CRAWLED_AT,
    });
    const byUrl = new Map(coverage.pages.map((p) => [p.url, p]));
    expect(byUrl.get(`${ORIGIN}/gone`)).toMatchObject({ status: "failed", reason: "http_error", httpStatus: 404 });
    expect(byUrl.get(`${ORIGIN}/redirecty`)).toMatchObject({ status: "failed", reason: "fetch_failed" });
    expect(byUrl.get(`${ORIGIN}/redirecty`)?.detail).toMatch(/network failure or a redirect/);
    expect(byUrl.get(`${ORIGIN}/huge`)).toMatchObject({ status: "failed", reason: "too_large" });
    expect(byUrl.get(`${ORIGIN}/pdf`)).toMatchObject({ status: "failed", reason: "not_html" });
    // Only the home page was scoreable.
    expect(site.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`]);
    expect(coverage.attempted).toBe(5);
    expect(coverage.crawled).toBe(1);
  });

  it("a body over the byte cap is refused whole (never truncated into the audit)", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, ROBOTS_ALLOW_ALL));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
    // No content-length header — the cap must catch it after the read.
    fetchPort.on("GET", exact(`${ORIGIN}/`), () => ({
      status: 200,
      headers: { get: (name: string) => (name.toLowerCase() === "content-type" ? "text/html" : null) },
      text: async () => `<p>${"x".repeat(5_000)}</p>`,
    }));
    const { site, coverage } = await crawlSite({
      fetchPort: fetchPort.port,
      startUrl: ORIGIN,
      crawledAt: CRAWLED_AT,
      bounds: { maxPageBytes: 1_000 },
    });
    expect(coverage.pages[0]).toMatchObject({ status: "failed", reason: "too_large" });
    expect(site.pages).toEqual([]);
  });
});

describe("crawlSite — bounds", () => {
  /** A hub page linking to /p1 … /pN, each a leaf. */
  function scriptWideSite(leafCount: number): ScriptedFetch {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, ROBOTS_ALLOW_ALL));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
    const links = Array.from({ length: leafCount }, (_, i) => `<a href="/p${i}">p${i}</a>`).join("");
    fetchPort.on("GET", exact(`${ORIGIN}/`), () => htmlResponse(200, `<title>hub</title>${links}`));
    fetchPort.on("GET", /\/p\d+$/, (req) => htmlResponse(200, `<title>${req.url}</title><p>leaf</p>`));
    return fetchPort;
  }

  it("maxPages is a hard cap on ATTEMPTED urls; the cut frontier is reported", async () => {
    const fetchPort = scriptWideSite(10);
    const { coverage } = await crawlSite({
      fetchPort: fetchPort.port,
      startUrl: ORIGIN,
      crawledAt: CRAWLED_AT,
      bounds: { maxPages: 4 },
    });
    expect(coverage.attempted).toBe(4);
    expect(coverage.crawled).toBe(4);
    expect(coverage.frontierTruncated).toBe(true);
    // robots + llms + exactly 4 page fetches.
    expect(fetchPort.requests).toHaveLength(6);
  });

  it("maxDepth stops link-following; links past the cap are reported as truncation", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact(`${ORIGIN}/robots.txt`), () => textResponse(200, ROBOTS_ALLOW_ALL));
    fetchPort.on("GET", exact(`${ORIGIN}/llms.txt`), () => textResponse(404, "no"));
    fetchPort.on("GET", exact(`${ORIGIN}/`), () => htmlResponse(200, `<a href="/a">a</a>`));
    fetchPort.on("GET", exact(`${ORIGIN}/a`), () => htmlResponse(200, `<a href="/b">b</a>`));
    // /b is NOT scripted: fetching it would throw — depth cap must prevent that.
    const { coverage } = await crawlSite({
      fetchPort: fetchPort.port,
      startUrl: ORIGIN,
      crawledAt: CRAWLED_AT,
      bounds: { maxDepth: 1 },
    });
    expect(coverage.pages.map((p) => p.url)).toEqual([`${ORIGIN}/`, `${ORIGIN}/a`]);
    expect(coverage.frontierTruncated).toBe(true);
  });

  it("a full crawl of a small site reports NO truncation", async () => {
    const fetchPort = scriptWideSite(2);
    const { coverage } = await crawlSite({ fetchPort: fetchPort.port, startUrl: ORIGIN, crawledAt: CRAWLED_AT });
    expect(coverage.attempted).toBe(3);
    expect(coverage.frontierTruncated).toBe(false);
  });
});
