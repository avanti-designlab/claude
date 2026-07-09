import { describe, expect, it } from "vitest";
import { AI_CRAWLERS } from "./crawlers";
import { evaluateCrawlerAccess } from "./robots-access";
import { makeCrawlResult, FIX_BASE_URL } from "./fixtures";
import type { CrawlerAccessVerdict } from "./types";

function verdictFor(verdicts: CrawlerAccessVerdict[], botId: string): CrawlerAccessVerdict {
  const v = verdicts.find((verdict) => verdict.botId === botId);
  if (!v) throw new Error(`no verdict for ${botId}`);
  return v;
}

describe("evaluateCrawlerAccess — enumeration + determinism", () => {
  it("emits one verdict per monitored crawler, in AI_CRAWLERS order", () => {
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxt: "" }));
    expect(verdicts.map((v) => v.botId)).toEqual(AI_CRAWLERS.map((c) => c.id));
    // The doc-05 four plus the widened set are all present.
    for (const id of ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot", "Bytespider"]) {
      expect(verdicts.some((v) => v.botId === id)).toBe(true);
    }
  });

  it("is deterministic — identical CrawlResult yields byte-identical verdicts", () => {
    const crawl = makeCrawlResult({ robotsTxt: "User-agent: GPTBot\nDisallow: /\n", pages: [[`${FIX_BASE_URL}/a`, true]] });
    expect(evaluateCrawlerAccess(crawl)).toEqual(evaluateCrawlerAccess(crawl));
  });
});

describe("evaluateCrawlerAccess — robots.txt honesty (status mapping)", () => {
  it("UNREACHABLE robots.txt → every verdict is unknown, never allowed", () => {
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxtStatus: "unreachable" }));
    for (const v of verdicts) {
      expect(v.access).toBe("unknown");
      expect(v.source).toBe("robots_unreachable");
      expect(v.blockedPaths).toEqual([]);
    }
  });

  it("ABSENT robots.txt (none served) → allowed by omission", () => {
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxtStatus: "absent" }));
    for (const v of verdicts) {
      expect(v.access).toBe("allowed");
      expect(v.source).toBe("no_robots_txt");
    }
  });

  it("empty fetched robots.txt allows everything", () => {
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxt: "" }));
    for (const v of verdicts) {
      expect(v.access).toBe("allowed");
      expect(v.source).toBe("robots_txt");
    }
  });
});

describe("evaluateCrawlerAccess — user-agent groups + precedence (via frozen isBotAllowed)", () => {
  it("a named group blocks only its bot; others in the same file stay allowed", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: *\nDisallow:\n";
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxt }));
    expect(verdictFor(verdicts, "GPTBot").access).toBe("blocked");
    expect(verdictFor(verdicts, "ClaudeBot").access).toBe("allowed");
    expect(verdictFor(verdicts, "PerplexityBot").access).toBe("allowed");
  });

  it("a bare `User-agent: *  Disallow: /` blocks EVERY monitored crawler", () => {
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxt: "User-agent: *\nDisallow: /\n" }));
    for (const v of verdicts) expect(v.access).toBe("blocked");
  });

  it("longest-path Allow beats Disallow (precedence delegated to isBotAllowed)", () => {
    // Blanket disallow, but the crawled path is explicitly allowed → allowed.
    const robotsTxt = "User-agent: GPTBot\nDisallow: /\nAllow: /blog\n";
    const crawl = makeCrawlResult({ robotsTxt, pages: [[`${FIX_BASE_URL}/blog`, true]] });
    const gpt = verdictFor(evaluateCrawlerAccess(crawl), "GPTBot");
    // Root "/" is still disallowed, so overall the bot is blocked from ≥1 path;
    // but the /blog path is NOT in the blocked list (Allow won there).
    expect(gpt.access).toBe("blocked");
    expect(gpt.blockedPaths).toContain("/");
    expect(gpt.blockedPaths).not.toContain("/blog");
  });

  it("wildcard + end-anchor rules block matching crawled paths", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /*.pdf$\n";
    const crawl = makeCrawlResult({
      robotsTxt,
      pages: [
        [`${FIX_BASE_URL}/files/report.pdf`, true],
        [`${FIX_BASE_URL}/files/report.pdf.html`, true],
      ],
    });
    const gpt = verdictFor(evaluateCrawlerAccess(crawl), "GPTBot");
    expect(gpt.blockedPaths).toContain("/files/report.pdf");
    // The end-anchor means .pdf.html is NOT blocked.
    expect(gpt.blockedPaths).not.toContain("/files/report.pdf.html");
    // Root "/" is not matched by /*.pdf$ → allowed there.
    expect(gpt.blockedPaths).not.toContain("/");
  });
});

describe("evaluateCrawlerAccess — evidence", () => {
  it("a blocked verdict carries blocked paths + governing Disallow directives + a summary", () => {
    const robotsTxt = "User-agent: GPTBot\nDisallow: /private\nDisallow: /admin\n";
    const crawl = makeCrawlResult({
      robotsTxt,
      pages: [
        [`${FIX_BASE_URL}/private`, true],
        [`${FIX_BASE_URL}/public`, true],
      ],
    });
    const gpt = verdictFor(evaluateCrawlerAccess(crawl), "GPTBot");
    expect(gpt.access).toBe("blocked");
    expect(gpt.blockedPaths).toEqual(["/private"]);
    expect(gpt.disallowDirectives).toEqual(expect.arrayContaining(["/private", "/admin"]));
    expect(gpt.robotsTxtUrl).toBe(`${FIX_BASE_URL}/robots.txt`);
    expect(gpt.testedPaths).toBe(3); // "/", "/private", "/public"
    expect(gpt.evidence).toContain("GPTBot");
  });

  it("an allowed verdict carries no blocked paths and no directives", () => {
    const gpt = verdictFor(evaluateCrawlerAccess(makeCrawlResult({ robotsTxt: "" })), "GPTBot");
    expect(gpt.blockedPaths).toEqual([]);
    expect(gpt.disallowDirectives).toEqual([]);
  });

  it("training-only third-party crawlers get honest verdicts too (superset coverage)", () => {
    const robotsTxt = "User-agent: CCBot\nDisallow: /\n";
    const verdicts = evaluateCrawlerAccess(makeCrawlResult({ robotsTxt }));
    expect(verdictFor(verdicts, "CCBot").access).toBe("blocked");
    expect(verdictFor(verdicts, "CCBot").citationRelevant).toBe(false);
    expect(verdictFor(verdicts, "GPTBot").access).toBe("allowed");
  });
});
