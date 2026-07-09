/**
 * M4 analyze suite — crawl reuse + the SSRF egress guard on competitor URLs.
 *
 * Competitor cited URLs are external and attacker-influenceable, so the SAME
 * egress closure M2 applies to client property URLs applies here. Pins: a
 * scriptable competitor site is crawled + scored; an internal competitor URL is
 * REFUSED before any connection (sync literal AND DNS-resolved) and EXCLUDED —
 * never counted as absence-of-signal; robots-blocked / unreachable competitors
 * are excluded with honest reasons. Reuses the shared ScriptedFetch harness.
 */

import { describe, expect, it } from "vitest";
import type { CitedUrlEntry } from "@/lib/intelligence/visibility";
import { SEED_PLAYBOOKS } from "@/lib/playbooks";
import { htmlResponse, ScriptedFetch, textResponse } from "@/lib/write-methods/shared/http-harness";
import type { ResolvePort } from "@/lib/intelligence/crawl";
import { analyzeCompetitors } from "./analyze";
import { competitorTargetsFromCitedUrls, resolveCompetitorCrawlUrl } from "./targets";
import type { CompetitorTarget } from "./types";

const PLAYBOOK = SEED_PLAYBOOKS["real-estate"];
const CRAWLED_AT = "2026-07-09T00:00:00.000Z";
const PUBLIC_RESOLVE: ResolvePort = async () => [{ address: "93.184.216.34" }];

function exact(url: string): RegExp {
  return new RegExp(`^${url.replace(/[.+?^${}()|[\]\\]/g, "\\$&")}$`);
}

function target(citedUrl: string, name: string | null = "Rival", domain: string | null = null): CompetitorTarget {
  return { citedUrl, domain, name, citationCount: 1, engines: [] };
}

/** A competitor site that answers robots/llms/page — crawlable and scorable. */
function crawlableSite(origin: string, page: string): ScriptedFetch {
  const fetchPort = new ScriptedFetch();
  fetchPort.on("GET", exact(`${origin}/robots.txt`), () => textResponse(200, "User-agent: *\nAllow: /\n"));
  fetchPort.on("GET", exact(`${origin}/llms.txt`), () => textResponse(404, "nope"));
  fetchPort.on("GET", exact(page), () =>
    htmlResponse(
      200,
      `<title>Guide</title><h1>Dubai buyer guide</h1>
       <p>${"Detailed direct answers to common expat buyer questions. ".repeat(4)}</p>
       <script type="application/ld+json">{"@type":"FAQPage"}</script>`,
    ),
  );
  return fetchPort;
}

describe("analyzeCompetitors — crawl reuse", () => {
  it("crawls + scores a reachable competitor via the shared M2 crawler", async () => {
    const fetchPort = crawlableSite("https://alpha.example", "https://alpha.example/guide");
    const results = await analyzeCompetitors({
      fetchPort: fetchPort.port,
      resolvePort: PUBLIC_RESOLVE,
      targets: [target("https://alpha.example/guide")],
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("scored");
    expect(results[0].audit).not.toBeNull();
    expect(results[0].coverage?.crawled).toBeGreaterThanOrEqual(1);
    expect(results[0].exclusionReason).toBeNull();
  });
});

describe("analyzeCompetitors — egress guard on competitor URLs (SSRF closure holds)", () => {
  it("refuses an internal IP-literal competitor URL BEFORE any connection and excludes it", async () => {
    const fetchPort = new ScriptedFetch(); // no routes: any fetch would throw
    const results = await analyzeCompetitors({
      fetchPort: fetchPort.port,
      resolvePort: PUBLIC_RESOLVE,
      targets: [target("http://169.254.169.254/latest/meta-data/")],
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });
    expect(results[0].status).toBe("excluded");
    expect(results[0].exclusionReason).toBe("blocked_address");
    expect(results[0].audit).toBeNull();
    // The sync literal pre-check refused it — the port was NEVER called.
    expect(fetchPort.requests).toHaveLength(0);
  });

  it("refuses a competitor host that RESOLVES to an internal address (DNS egress guard) and excludes it", async () => {
    const fetchPort = new ScriptedFetch(); // no routes: any fetch would throw
    const internalResolve: ResolvePort = async () => [{ address: "127.0.0.1" }];
    const results = await analyzeCompetitors({
      fetchPort: fetchPort.port,
      resolvePort: internalResolve,
      targets: [target("https://rebind.example/guide")],
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });
    expect(results[0].status).toBe("excluded");
    expect(results[0].exclusionReason).toBe("blocked_address");
    // The guard resolves first and refuses — no page fetch is ever issued.
    expect(fetchPort.requests).toHaveLength(0);
  });

  it("excludes a robots-blocked competitor as robots_blocked, not as a scored zero", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact("https://blocked.example/robots.txt"), () =>
      textResponse(200, "User-agent: *\nDisallow: /\n"),
    );
    fetchPort.on("GET", exact("https://blocked.example/llms.txt"), () => textResponse(404, "nope"));
    const results = await analyzeCompetitors({
      fetchPort: fetchPort.port,
      resolvePort: PUBLIC_RESOLVE,
      targets: [target("https://blocked.example/guide")],
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });
    expect(results[0].status).toBe("excluded");
    expect(results[0].exclusionReason).toBe("robots_blocked");
    expect(results[0].audit).toBeNull();
  });

  it("excludes an unreachable competitor (page errors) as unreachable", async () => {
    const fetchPort = new ScriptedFetch();
    fetchPort.on("GET", exact("https://dead.example/robots.txt"), () => textResponse(200, "User-agent: *\nAllow: /\n"));
    fetchPort.on("GET", exact("https://dead.example/llms.txt"), () => textResponse(404, "nope"));
    fetchPort.on("GET", exact("https://dead.example/guide"), () => textResponse(500, "server error"));
    const results = await analyzeCompetitors({
      fetchPort: fetchPort.port,
      resolvePort: PUBLIC_RESOLVE,
      targets: [target("https://dead.example/guide")],
      playbook: PLAYBOOK,
      crawledAt: CRAWLED_AT,
    });
    expect(results[0].status).toBe("excluded");
    expect(results[0].exclusionReason).toBe("unreachable");
  });
});

describe("competitorTargetsFromCitedUrls — the M3 → M4 derivation", () => {
  function entry(over: Partial<CitedUrlEntry> & Pick<CitedUrlEntry, "url" | "attribution">): CitedUrlEntry {
    return {
      domain: null,
      competitor: null,
      count: 1,
      engines: [],
      ...over,
    };
  }

  it("takes ONLY competitor-attributed cited URLs, preserving M3 order + fields", () => {
    const citedUrls: CitedUrlEntry[] = [
      entry({ url: "https://rival.example/x", domain: "rival.example", attribution: "competitor", competitor: "Rival", count: 3, engines: ["chatgpt"] }),
      entry({ url: "https://client.example/y", attribution: "client" }),
      entry({ url: "https://news.example/z", attribution: "other" }),
      entry({ url: "https://foe.example", domain: "foe.example", attribution: "competitor", competitor: "Foe", count: 1 }),
    ];
    const targets = competitorTargetsFromCitedUrls(citedUrls);
    expect(targets).toEqual([
      { citedUrl: "https://rival.example/x", domain: "rival.example", name: "Rival", citationCount: 3, engines: ["chatgpt"] },
      { citedUrl: "https://foe.example", domain: "foe.example", name: "Foe", citationCount: 1, engines: [] },
    ]);
  });
});

describe("resolveCompetitorCrawlUrl — crawl-target resolution", () => {
  it("uses a verbatim http(s) cited URL as the crawl target", () => {
    expect(resolveCompetitorCrawlUrl(target("https://rival.example/guide"))).toEqual({
      kind: "url",
      url: "https://rival.example/guide",
    });
  });

  it("falls back to the competitor origin when the cited source is a bare host", () => {
    expect(resolveCompetitorCrawlUrl(target("rival.example", "Rival", "rival.example"))).toEqual({
      kind: "url",
      url: "https://rival.example/",
    });
  });

  it("refuses a non-URL source with no derivable host as not_crawlable_url", () => {
    expect(resolveCompetitorCrawlUrl(target("not a url", "Rival", null))).toEqual({
      kind: "blocked",
      reason: "not_crawlable_url",
    });
  });

  it("refuses an internal IP-literal cited URL as blocked_address (sync pre-check)", () => {
    expect(resolveCompetitorCrawlUrl(target("http://10.0.0.5/admin"))).toEqual({
      kind: "blocked",
      reason: "blocked_address",
    });
  });

  it("refuses a non-http(s) scheme as not_crawlable_url", () => {
    expect(resolveCompetitorCrawlUrl(target("ftp://rival.example/x", "Rival", null))).toEqual({
      kind: "blocked",
      reason: "not_crawlable_url",
    });
  });
});
