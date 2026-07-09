/**
 * M5 — AI crawler + render-visibility monitoring: result contracts
 * (doc 05 M5; doc 07 §1.4).
 *
 * These are the shapes `analyzeMonitor` produces from a `CrawlResult` (the
 * reused M2 crawl layer's output) and the M19 dashboard + M17 alerting consume.
 * Every verdict is HONEST about missing data: an unreachable robots.txt yields
 * `unknown` (never a fabricated "allowed"); a page that failed to crawl yields
 * `unknown` render status (never a fabricated "invisible").
 */

import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { CrawlerRole } from "./crawlers";

/* ------------------------------------------------------------------ */
/* Crawler access                                                      */
/* ------------------------------------------------------------------ */

export type CrawlerAccess =
  /** robots.txt permits this crawler on every tested path (or no robots.txt served). */
  | "allowed"
  /** robots.txt disallows this crawler from ≥1 tested path. */
  | "blocked"
  /** robots.txt was unreachable — the rules are unknown, NOT asserted allowed. */
  | "unknown";

/** Where the verdict came from — the "which file / which basis" evidence. */
export type CrawlerAccessSource =
  /** A served robots.txt was parsed for this verdict. */
  | "robots_txt"
  /** No robots.txt served (4xx/absent) — everything is allowed by omission. */
  | "no_robots_txt"
  /** robots.txt was unreachable (5xx/network) — verdict is `unknown`. */
  | "robots_unreachable";

/** One crawler's access verdict, with the evidence that produced it. */
export interface CrawlerAccessVerdict {
  /** Robots.txt user-agent token (AiCrawler.id). */
  botId: string;
  operator: string;
  role: CrawlerRole;
  citationRelevant: boolean;
  access: CrawlerAccess;
  source: CrawlerAccessSource;
  /** The robots.txt URL this verdict was (or would be) read from. */
  robotsTxtUrl: string;
  /** Tested paths (root + crawled page paths, de-duplicated). */
  testedPaths: number;
  /** Of the tested paths, those this crawler is disallowed from (empty unless blocked). */
  blockedPaths: string[];
  /**
   * The governing group's Disallow rule paths (evidence only — reused
   * `parseRobotsTxt` output, not a re-decided verdict). Empty when none apply.
   */
  disallowDirectives: string[];
  /** Human-readable, non-sensitive summary line. */
  evidence: string;
}

/* ------------------------------------------------------------------ */
/* Render visibility                                                   */
/* ------------------------------------------------------------------ */

export type RenderStatus =
  /** Primary content present in raw server HTML — an AI crawler sees it. */
  | "visible"
  /** Content requires client-side JS — a visibility RISK for non-rendering crawlers. */
  | "js_dependent"
  /** The page could not be crawled — render status is unknown, NOT "invisible". */
  | "unknown";

export interface PageRenderVerdict {
  url: string;
  status: RenderStatus;
  detail: string;
}

export interface RenderVisibilityReport {
  pages: PageRenderVerdict[];
  visibleCount: number;
  jsDependentCount: number;
  unknownCount: number;
  /** URLs judged `js_dependent` — the visibility-risk set (sorted). */
  jsDependentUrls: string[];
}

/* ------------------------------------------------------------------ */
/* Property-level roll-up                                              */
/* ------------------------------------------------------------------ */

/** The full M5 status for one property, from one monitoring pass. */
export interface PropertyMonitorReport {
  baseUrl: string;
  /** Caller-supplied crawl timestamp (determinism) — the pass's identity. */
  crawledAt: string;
  robotsTxtStatus: CrawlCoverage["robotsTxtStatus"];
  llmsTxtStatus: CrawlCoverage["llmsTxtStatus"];
  crawlers: CrawlerAccessVerdict[];
  render: RenderVisibilityReport;
  /** The per-page crawl-honesty record, carried through unchanged. */
  coverage: CrawlCoverage;
  /** botIds whose access is `blocked` (sorted). */
  blockedCrawlers: string[];
  /** botIds whose access is `unknown` (sorted) — surfaced, never alerted. */
  unknownCrawlers: string[];
  /** True iff ≥1 crawler is `blocked`. */
  hasCrawlerBlock: boolean;
  /** True iff ≥1 crawled page is `js_dependent`. */
  hasRenderRisk: boolean;
}
