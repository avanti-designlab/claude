import { describe, expect, it } from "vitest";
import { checkAiCrawlerAccess } from "./checks/ai-crawler-access";
import { checkInternalLinking } from "./checks/internal-linking";
import { checkEntityConsistency } from "./checks/entity-consistency";
import { checkCoreWebVitals } from "./checks/core-web-vitals";
import { BASE_URL, ctx, ecommercePlaybook, jsonLd, makePage, makeSite, realEstatePlaybook } from "./fixtures";

describe("check 5 — AI-crawler access", () => {
  it("scores 100 when all four AI bots are allowed and pages render without JS", () => {
    const outcome = checkAiCrawlerAccess(ctx(makeSite()));
    expect(outcome.score).toBe(100);
    expect(outcome.fixes).toHaveLength(0);
  });

  it("flags robots.txt blocks per bot with a critical M13 fix", () => {
    const site = makeSite({ robotsTxt: "User-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n\nUser-agent: *\nAllow: /\n" });
    const outcome = checkAiCrawlerAccess(ctx(site));
    expect(outcome.score).toBe(70); // 2 of 4 bots fully blocked → 60×0.5 + 40
    expect(outcome.evidence.some((e) => e.field === "GPTBot")).toBe(true);
    expect(outcome.evidence.some((e) => e.field === "ClaudeBot")).toBe(true);
    expect(outcome.evidence.some((e) => e.field === "PerplexityBot")).toBe(false);
    const fix = outcome.fixes.find((f) => f.id === "ai_crawler_access/unblock-ai-crawlers");
    expect(fix).toMatchObject({
      impact: "critical",
      module: "M13",
      automationLevel: "ai_draft_human_approve",
      targetUrls: [`${BASE_URL}/robots.txt`],
    });
    expect(fix?.title).toContain("GPTBot, ClaudeBot");
  });

  it("flags JS-render-invisible pages with a human_only rendering fix", () => {
    const invisible = `${BASE_URL}/spa`;
    const site = makeSite({
      pages: [makePage({ url: `${BASE_URL}/` }), makePage({ url: invisible, rendersWithoutJs: false })],
    });
    const outcome = checkAiCrawlerAccess(ctx(site));
    expect(outcome.score).toBe(80); // robots 60 + render 40×0.5
    const fix = outcome.fixes.find((f) => f.id === "ai_crawler_access/fix-js-render-visibility");
    expect(fix).toMatchObject({ module: "M13", automationLevel: "human_only", impact: "critical", targetUrls: [invisible] });
  });
});

describe("check 6 — internal-linking density", () => {
  it("scores 100 for a fully linked small site", () => {
    expect(checkInternalLinking(ctx(makeSite())).score).toBe(100);
  });

  it("detects orphan pages (homepage exempt) and dead ends", () => {
    const orphan = `${BASE_URL}/orphan`;
    const site = makeSite({
      pages: [
        makePage({ url: `${BASE_URL}/`, internalLinks: [`${BASE_URL}/a`] }),
        makePage({ url: `${BASE_URL}/a`, internalLinks: [`${BASE_URL}/`] }),
        makePage({ url: orphan, internalLinks: [] }), // orphan AND dead end
      ],
    });
    const outcome = checkInternalLinking(ctx(site));
    expect(outcome.evidence.some((e) => e.url === orphan && e.field === "inbound links")).toBe(true);
    expect(outcome.evidence.some((e) => e.url === orphan && e.field === "outbound links")).toBe(true);
    // 1/2 non-home orphaned (−30), 1/3 dead-end (−6.7) → 63.3
    expect(outcome.score).toBe(63.3);
    const orphanFix = outcome.fixes.find((f) => f.id === "internal_linking/link-orphan-pages");
    expect(orphanFix).toMatchObject({ impact: "high", module: "M13", targetUrls: [orphan] });
  });

  it("normalizes URLs (trailing slash, relative hrefs) when matching links", () => {
    const site = makeSite({
      pages: [
        makePage({ url: `${BASE_URL}/`, internalLinks: ["/a/"] }), // relative + trailing slash
        makePage({ url: `${BASE_URL}/a`, internalLinks: [`${BASE_URL}/`] }),
      ],
    });
    expect(checkInternalLinking(ctx(site)).score).toBe(100);
  });

  it("expects a hub page on larger sites and emits an M8 pillar fix when absent", () => {
    // 7 pages in a chain: no page links to ≥30% of the others.
    const urls = Array.from({ length: 7 }, (_, i) => `${BASE_URL}/p${i}`);
    const pages = urls.map((url, i) =>
      makePage({ url, internalLinks: [urls[(i + 1) % urls.length]] }),
    );
    const site = makeSite({ pages });
    const outcome = checkInternalLinking(ctx(site));
    expect(outcome.evidence.some((e) => e.field === "hub structure")).toBe(true);
    expect(outcome.fixes.some((f) => f.id === "internal_linking/build-hub-structure" && f.module === "M8")).toBe(true);
  });
});

describe("check 7 — entity consistency", () => {
  const entity = { name: "Acme Realty LLC", phone: "+1 (619) 555-0100", address: "123 Main Street, San Diego, CA 92101" };

  const orgBlock = (name: string, telephone?: string): string =>
    jsonLd({ "@context": "https://schema.org", "@type": "RealEstateAgent", name, ...(telephone ? { telephone } : {}) });

  it("passes when on-site org signals and directory records match canonically", () => {
    const site = makeSite({
      entity,
      pages: [makePage({ url: `${BASE_URL}/`, jsonLdBlocks: [orgBlock("Acme Realty", "619-555-0100")] })],
      napRecords: [
        { directory: "Google", name: "Acme Realty, LLC", address: "123 Main St, San Diego, CA 92101", phone: "6195550100" },
      ],
    });
    const outcome = checkEntityConsistency(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(100);
  });

  it("flags name/phone mismatches with expected-vs-found evidence", () => {
    const site = makeSite({
      entity,
      pages: [makePage({ url: `${BASE_URL}/`, jsonLdBlocks: [orgBlock("Acme Property Group", "619-555-9999")] })],
    });
    const outcome = checkEntityConsistency(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(0);
    const nameFinding = outcome.evidence.find((e) => e.field === "name");
    expect(nameFinding).toMatchObject({ url: `${BASE_URL}/`, expected: "Acme Realty LLC", found: "Acme Property Group" });
    expect(outcome.evidence.some((e) => e.field === "phone")).toBe(true);
    expect(outcome.fixes.some((f) => f.id === "entity_consistency/align-onsite-entity" && f.module === "M13")).toBe(true);
  });

  it("routes directory mismatches to M14 and ignores napRecords for national playbooks", () => {
    const site = makeSite({
      entity,
      pages: [makePage({ url: `${BASE_URL}/`, jsonLdBlocks: [orgBlock("Acme Realty")] })],
      napRecords: [{ directory: "Google", name: "Totally Different Name", address: null, phone: null }],
    });
    const semiLocal = checkEntityConsistency(ctx(site, realEstatePlaybook));
    expect(semiLocal.fixes.some((f) => f.id === "entity_consistency/align-directory-entity" && f.module === "M14")).toBe(true);
    const national = checkEntityConsistency(ctx(site, ecommercePlaybook));
    expect(national.score).toBe(100); // directory record not in scope for national
  });

  it("penalizes declared credentials that appear nowhere on-site", () => {
    const site = makeSite({
      entity: { ...entity, credentials: ["RERA 12345", "NAR"] },
      pages: [
        makePage({
          url: `${BASE_URL}/about`,
          visibleText: "Jane is a NAR member advisor.",
          jsonLdBlocks: [orgBlock("Acme Realty")],
        }),
      ],
    });
    const outcome = checkEntityConsistency(ctx(site, realEstatePlaybook));
    expect(outcome.score).toBe(95); // one missing credential → −5
    expect(outcome.evidence.some((e) => e.field === "credential" && e.expected === "RERA 12345")).toBe(true);
    expect(outcome.fixes.some((f) => f.id === "entity_consistency/surface-credentials" && f.module === "M8")).toBe(true);
  });

  it("skips as no_data when there is nothing to compare", () => {
    const outcome = checkEntityConsistency(ctx(makeSite(), realEstatePlaybook));
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBe("no_data");
  });
});

describe("check 11 — Core Web Vitals", () => {
  it("skips as no_data when no CWV samples are supplied", () => {
    const outcome = checkCoreWebVitals(ctx(makeSite()));
    expect(outcome.status).toBe("skipped");
    expect(outcome.skipReason).toBe("no_data");
  });

  it("passes all-good metrics", () => {
    const site = makeSite({ coreWebVitals: [{ url: `${BASE_URL}/`, lcpMs: 1800, inpMs: 150, cls: 0.05 }] });
    expect(checkCoreWebVitals(ctx(site)).score).toBe(100);
  });

  it("names the failing metric with thresholds in evidence", () => {
    const site = makeSite({ coreWebVitals: [{ url: `${BASE_URL}/`, lcpMs: 4800, inpMs: 300, cls: 0.05 }] });
    const outcome = checkCoreWebVitals(ctx(site));
    expect(outcome.score).toBe(50); // LCP poor (0) + INP NI (50) + CLS good (100) → 50
    const lcp = outcome.evidence.find((e) => e.field === "LCP");
    expect(lcp).toMatchObject({ url: `${BASE_URL}/`, expected: "≤2500ms (good)", found: "4800ms" });
    expect(lcp?.message).toContain("poor");
    const fix = outcome.fixes[0];
    expect(fix).toMatchObject({ impact: "high", module: "M13", automationLevel: "human_only" });
  });

  it("ignores null metrics and averages across samples", () => {
    const site = makeSite({
      coreWebVitals: [
        { url: `${BASE_URL}/`, lcpMs: 2000, inpMs: null, cls: null },
        { url: `${BASE_URL}/slow`, lcpMs: 3000, inpMs: null, cls: null },
      ],
    });
    expect(checkCoreWebVitals(ctx(site)).score).toBe(75); // 100 and 50 averaged
  });
});
