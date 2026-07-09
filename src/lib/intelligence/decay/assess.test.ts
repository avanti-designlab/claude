/**
 * M6 decay engine — pure assessment (`assessDecay`).
 *
 * Pins the review-gated hard properties:
 *  - deterministic scoring (same crawl → byte-identical report);
 *  - AGE-UNKNOWN HONESTY: no last-modified signal ⇒ status "age_unknown",
 *    never fresh, never stale, never a fabricated age;
 *  - future-dated is suspect, not fresh;
 *  - stale-stat / thin content signals are real (drawn from the crawl);
 *  - thresholds are documented constants (⚑ launch-ratify), reused from the skill;
 *  - UNCRAWLABLE pages are EXCLUDED and reported as excluded;
 *  - the refresh queue is "worst decay first".
 */

import { describe, expect, it } from "vitest";
import type { CrawledPage, CrawledSite } from "@/lib/skills/aeo-audit";
import { DEFAULT_REFRESH_WINDOW_DAYS } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import { assessDecay } from "./assess";
import {
  DECAY_REFRESH_WINDOW_DAYS,
  DECAY_THRESHOLD_FLAGS,
  STALE_THRESHOLD_MULTIPLIER,
  THIN_CONTENT_MIN_WORDS,
} from "./types";

const CRAWLED_AT = "2026-07-01T00:00:00.000Z";
const BASE = "https://client.example";

/** Enough visible words (≈200) to clear the thin-content floor unless a test wants thin. */
const THICK = "Substantive advisory copy answering real buyer questions in genuine detail. ".repeat(20);

function page(overrides: Partial<CrawledPage> & { url: string }): CrawledPage {
  return {
    url: overrides.url,
    title: overrides.title ?? "Title",
    metaDescription: overrides.metaDescription ?? "desc",
    h1s: overrides.h1s ?? ["H1"],
    visibleText: overrides.visibleText ?? THICK,
    jsonLdBlocks: overrides.jsonLdBlocks ?? [],
    images: overrides.images ?? [],
    internalLinks: overrides.internalLinks ?? [],
    hasVideo: overrides.hasVideo ?? false,
    hasTranscript: overrides.hasTranscript ?? false,
    lastModified: "lastModified" in overrides ? overrides.lastModified! : null,
    rendersWithoutJs: overrides.rendersWithoutJs ?? true,
  };
}

/** ISO `days` before the crawl. */
function daysBefore(days: number): string {
  return new Date(Date.parse(CRAWLED_AT) - days * 86_400_000).toISOString();
}

function site(pages: CrawledPage[]): CrawledSite {
  return { baseUrl: BASE, crawledAt: CRAWLED_AT, pages, robotsTxt: null, llmsTxt: null };
}

function coverage(attempted: number, crawled: number): CrawlCoverage {
  return {
    attempted,
    crawled,
    pages: [],
    robotsTxtStatus: "fetched",
    llmsTxtStatus: "absent",
    frontierTruncated: false,
    offOriginRefused: 0,
  };
}

/** Full coverage (attempted == crawled == n). */
function fullCoverage(n: number): CrawlCoverage {
  return coverage(n, n);
}

describe("assessDecay — determinism", () => {
  it("same crawl → byte-identical report (no wall-clock, no randomness)", () => {
    const s = site([
      page({ url: `${BASE}/fresh`, lastModified: daysBefore(10) }),
      page({ url: `${BASE}/aging`, lastModified: daysBefore(120) }),
      page({ url: `${BASE}/stale`, lastModified: daysBefore(400) }),
      page({ url: `${BASE}/unknown`, lastModified: null }),
    ]);
    const a = assessDecay(s, fullCoverage(4));
    const b = assessDecay(s, fullCoverage(4));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("ages are measured against crawledAt, not Date.now — an old crawl re-scores identically", () => {
    // crawledAt in the far past: a page 400 days before it is still 400 days
    // old, NOT ~centuries old by wall-clock.
    const oldCrawl: CrawledSite = {
      baseUrl: BASE,
      crawledAt: "2020-01-01T00:00:00.000Z",
      pages: [page({ url: `${BASE}/p`, lastModified: "2019-11-01T00:00:00.000Z" })],
      robotsTxt: null,
      llmsTxt: null,
    };
    const report = assessDecay(oldCrawl, fullCoverage(1));
    expect(report.pages[0].ageDays).toBe(61); // Nov 1 → Jan 1
    expect(report.pages[0].status).toBe("fresh"); // 61 ≤ 90
  });
});

describe("assessDecay — AGE-UNKNOWN honesty (never fresh, never stale, never fabricated)", () => {
  it("no last-modified signal ⇒ age_unknown, null score, null age, and NOT classified fresh/stale", () => {
    const report = assessDecay(site([page({ url: `${BASE}/p`, lastModified: null })]), fullCoverage(1));
    const p = report.pages[0];
    expect(p.status).toBe("age_unknown");
    expect(p.status).not.toBe("fresh");
    expect(p.status).not.toBe("stale");
    expect(p.decayScore).toBeNull(); // a fabricated 0 would read as fresh — refused
    expect(p.ageDays).toBeNull(); // never invented
    expect(p.signals.map((s) => s.kind)).toContain("no_last_modified");
    // Not queued for a content refresh (it needs a metadata signal, not a rewrite).
    expect(report.refreshQueue).toHaveLength(0);
    expect(report.summary.ageUnknown).toBe(1);
    expect(report.summary.fresh).toBe(0);
    expect(report.summary.stale).toBe(0);
  });

  it("an UNPARSABLE last-modified is age_unknown too — not silently treated as stale", () => {
    const p = assessDecay(site([page({ url: `${BASE}/p`, lastModified: "not-a-date" })]), fullCoverage(1)).pages[0];
    expect(p.status).toBe("age_unknown");
    expect(p.ageDays).toBeNull();
    expect(p.signals.find((s) => s.kind === "no_last_modified")?.detail).toMatch(/unparsable/i);
  });

  it("age_unknown WITH observed content decay: status stays age_unknown, score reflects ONLY the content signal", () => {
    const p = assessDecay(
      site([page({ url: `${BASE}/p`, lastModified: null, visibleText: "Our data from 2018 is quoted here. " + THICK })]),
      fullCoverage(1)
    ).pages[0];
    expect(p.status).toBe("age_unknown"); // still can't claim fresh OR stale
    expect(p.decayScore).toBe(DECAY_THRESHOLD_FLAGS.STALE_STAT_POINTS); // content-only, no fabricated age points
    expect(p.signals.map((s) => s.kind)).toEqual(expect.arrayContaining(["stale_dated_statistic", "no_last_modified"]));
  });
});

describe("assessDecay — age bands + suspect future-dated", () => {
  it("fresh within window → score 0, not queued", () => {
    const report = assessDecay(site([page({ url: `${BASE}/p`, lastModified: daysBefore(30) })]), fullCoverage(1));
    expect(report.pages[0].status).toBe("fresh");
    expect(report.pages[0].decayScore).toBe(0);
    expect(report.refreshQueue).toHaveLength(0);
  });

  it("past the window but under stale → aging; past 2× window → stale (score 100)", () => {
    const report = assessDecay(
      site([
        page({ url: `${BASE}/aging`, lastModified: daysBefore(120) }),
        page({ url: `${BASE}/stale`, lastModified: daysBefore(400) }),
      ]),
      fullCoverage(2)
    );
    const aging = report.pages.find((p) => p.url.endsWith("/aging"))!;
    const stale = report.pages.find((p) => p.url.endsWith("/stale"))!;
    expect(aging.status).toBe("aging");
    expect(stale.status).toBe("stale");
    expect(stale.decayScore).toBe(100);
    expect(aging.decayScore).toBeGreaterThan(0);
    expect(aging.decayScore!).toBeLessThan(stale.decayScore!);
  });

  it("future-dated last-modified is SUSPECT, not fresh; age not asserted", () => {
    const future = new Date(Date.parse(CRAWLED_AT) + 30 * 86_400_000).toISOString();
    const p = assessDecay(site([page({ url: `${BASE}/p`, lastModified: future })]), fullCoverage(1)).pages[0];
    expect(p.status).toBe("suspect_future_dated");
    expect(p.status).not.toBe("fresh");
    expect(p.ageDays).toBeNull();
    expect(p.signals.map((s) => s.kind)).toContain("future_dated");
    expect(report_recommendationMentions(p.recommendation, "cosmetic date-bumping")).toBe(true);
  });
});

describe("assessDecay — real content signals (from the crawl only)", () => {
  it("stale dated statistics (≥2y) are flagged; recent years are not", () => {
    const report = assessDecay(
      site([
        page({ url: `${BASE}/old`, lastModified: daysBefore(10), visibleText: "Market figures from 2019 remain cited. " + THICK }),
        page({ url: `${BASE}/recent`, lastModified: daysBefore(10), visibleText: "As of 2025 the market shifted. " + THICK }),
      ]),
      fullCoverage(2)
    );
    const old = report.pages.find((p) => p.url.endsWith("/old"))!;
    const recent = report.pages.find((p) => p.url.endsWith("/recent"))!;
    expect(old.signals.map((s) => s.kind)).toContain("stale_dated_statistic");
    expect(recent.signals.map((s) => s.kind)).not.toContain("stale_dated_statistic");
    // A fresh-by-age page carrying a stale stat still lands on the refresh queue.
    expect(report.refreshQueue.map((p) => p.url)).toContain(old.url);
    expect(report.summary.withStaleStats).toBe(1);
  });

  it("thin content is flagged below the word floor", () => {
    const report = assessDecay(
      site([page({ url: `${BASE}/thin`, lastModified: daysBefore(5), visibleText: "Three visible words." })]),
      fullCoverage(1)
    );
    const p = report.pages[0];
    expect(p.signals.map((s) => s.kind)).toContain("thin_content");
    expect(report.summary.thin).toBe(1);
    expect(THIN_CONTENT_MIN_WORDS).toBeGreaterThan(3);
  });
});

describe("assessDecay — uncrawlable exclusion + refresh-queue ordering", () => {
  it("pages the crawl could not read are EXCLUDED and counted as excluded", () => {
    // 5 attempted, 2 crawled; only the 2 crawled pages are handed in.
    const report = assessDecay(
      site([page({ url: `${BASE}/a`, lastModified: daysBefore(400) }), page({ url: `${BASE}/b`, lastModified: daysBefore(10) })]),
      coverage(5, 2)
    );
    expect(report.summary.assessed).toBe(2);
    expect(report.summary.uncrawlableExcluded).toBe(3);
    expect(report.pages).toHaveLength(2); // never invents rows for uncrawled pages
  });

  it("the refresh queue is worst-decay-first, deterministic tiebreak on url", () => {
    const report = assessDecay(
      site([
        page({ url: `${BASE}/mild`, lastModified: daysBefore(100) }),
        page({ url: `${BASE}/worst`, lastModified: daysBefore(500) }),
        page({ url: `${BASE}/mid`, lastModified: daysBefore(250) }),
        page({ url: `${BASE}/fresh`, lastModified: daysBefore(5) }),
      ]),
      fullCoverage(4)
    );
    expect(report.refreshQueue.map((p) => p.url)).toEqual([`${BASE}/worst`, `${BASE}/mid`, `${BASE}/mild`]);
    for (let i = 1; i < report.refreshQueue.length; i += 1) {
      expect(report.refreshQueue[i - 1].decayScore!).toBeGreaterThanOrEqual(report.refreshQueue[i].decayScore!);
    }
  });
});

describe("assessDecay — thresholds documented + reused, refresh window overridable", () => {
  it("the refresh-window default is REUSED from the aeo-audit skill (no drift)", () => {
    expect(DECAY_REFRESH_WINDOW_DAYS).toBe(DEFAULT_REFRESH_WINDOW_DAYS);
    expect(DECAY_REFRESH_WINDOW_DAYS).toBe(90);
  });

  it("every doc-silent decay threshold is exposed in the ⚑ flag registry", () => {
    expect(Object.keys(DECAY_THRESHOLD_FLAGS).sort()).toEqual(
      [
        "AGE_AGING_MAX_POINTS",
        "AGE_STALE_MAX_POINTS",
        "DECAY_REFRESH_WINDOW_DAYS",
        "FUTURE_DATED_POINTS",
        "STALE_STAT_MIN_AGE_YEARS",
        "STALE_STAT_POINTS",
        "STALE_THRESHOLD_MULTIPLIER",
        "THIN_CONTENT_MIN_WORDS",
        "THIN_CONTENT_POINTS",
      ].sort()
    );
  });

  it("the report echoes the resolved window + stale threshold; window is overridable", () => {
    const report = assessDecay(site([page({ url: `${BASE}/p`, lastModified: daysBefore(45) })]), fullCoverage(1), {
      refreshWindowDays: 30,
    });
    expect(report.refreshWindowDays).toBe(30);
    expect(report.staleThresholdDays).toBe(30 * STALE_THRESHOLD_MULTIPLIER);
    // 45 days > 30-day window ⇒ now aging (was fresh under the 90-day default).
    expect(report.pages[0].status).toBe("aging");
  });

  it("a non-positive / non-finite window override falls back to the default", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const report = assessDecay(site([page({ url: `${BASE}/p`, lastModified: daysBefore(45) })]), fullCoverage(1), {
        refreshWindowDays: bad,
      });
      expect(report.refreshWindowDays).toBe(DECAY_REFRESH_WINDOW_DAYS);
    }
  });
});

/** Small readability helper (keeps the assertion above legible). */
function report_recommendationMentions(rec: string, needle: string): boolean {
  return rec.toLowerCase().includes(needle.toLowerCase());
}
