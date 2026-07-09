/**
 * M2 crawl layer — types (doc 05 M2; doc 07 §1.4).
 *
 * The crawler's OUTPUT contract is the aeo-audit skill's INPUT contract:
 * `CrawlResult.site` is a ready-to-score `CrawledSite` (the frozen 0.2 skill
 * consumes it as-is — M2 wraps the skill, it never reimplements the rubric).
 * Alongside the site rides `CrawlCoverage`: the per-page honesty record of
 * what was and was NOT crawlable, so an audit computed from partial data can
 * never silently pass itself off as an audit of the whole site.
 */

import type { CrawledSite } from "@/lib/skills/aeo-audit";

/**
 * The bot identity this crawler answers to in robots.txt (matched against
 * named groups and `*` via the skill's reusable robots parser). We audit
 * sites we are hired to audit, but we still respect an explicit block —
 * a site that blocks us gets an honest "we could not crawl X" instead of a
 * stealth crawl.
 */
export const AUDIT_CRAWLER_BOT = "AEO-AuditBot";

/** User-Agent header sent on every crawl request — honest bot identification. */
export const AUDIT_CRAWLER_USER_AGENT = `Mozilla/5.0 (compatible; ${AUDIT_CRAWLER_BOT}/1.0)`;

/**
 * Crawl bounds. Every field is a hard limit — the crawler NEVER exceeds them.
 * Defaults are doc-silent engineering choices (doc 02/05 give no crawl
 * budget); sized for the small-business sites the seed verticals serve and
 * flagged for ratification alongside the other aeo-audit launch thresholds
 * (BUILD-STATE ⚑ list).
 */
export interface CrawlBounds {
  /** Maximum URLs ATTEMPTED (crawled + failed both count). */
  maxPages: number;
  /** Maximum link depth from the start URL (start = depth 0). */
  maxDepth: number;
  /**
   * Maximum HTML size per page, in characters of the decoded body (≈ bytes
   * for typical HTML; the Content-Length header, when present, is checked in
   * real bytes before the body is read). Over-cap pages are REFUSED, never
   * truncated — scoring half a page as if it were whole would misreport
   * missing-schema/missing-content findings.
   */
  maxPageBytes: number;
  /**
   * Overall wall-clock budget for the whole crawl, in ms. Checked between page
   * fetches: once exceeded, the crawl ends early and every unreached queued URL
   * is recorded honestly as `budget_exhausted` (never silently dropped). Bounds
   * total time even when many pages each answer slowly — the pages/depth/byte
   * caps bound WORK, this bounds TIME. ⚑ Doc-silent default (see below).
   */
  wallClockBudgetMs: number;
}

/**
 * Per-request timeout, in ms — applied at the LIVE fetch seam
 * (`audit/live-fetch.ts`, via `AbortSignal.timeout`) because the injected
 * FetchPort contract carries no signal and is out of this module's scope.
 * Bounds a single hung request (undici's own default is ~300s, far too long
 * for an interactive audit). ⚑ Doc-silent default, flagged for ratification
 * with the crawl bounds above.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

export const DEFAULT_CRAWL_BOUNDS: CrawlBounds = {
  maxPages: 30,
  maxDepth: 3,
  maxPageBytes: 1_500_000,
  wallClockBudgetMs: 120_000,
};

/** Why a URL could not be crawled — every reason is stated, never swallowed. */
export type PageFailureReason =
  /** robots.txt disallows AEO-AuditBot from this path — we honored the block. */
  | "robots_disallowed"
  /** robots.txt itself was unreachable (5xx/network) — crawling without knowing the rules is not done. */
  | "robots_unavailable"
  /**
   * The URL did not answer: network failure OR a redirect. The shared
   * FetchPort pins `redirect: "error"` (a write/audit must land at exactly
   * the URL it targeted), and WHATWG "error" semantics reject without
   * exposing which of the two happened — so this reason honestly names both.
   */
  | "fetch_failed"
  /** Non-2xx HTTP status. */
  | "http_error"
  /** The response declared a non-HTML content type. */
  | "not_html"
  /** The body exceeds `maxPageBytes` — refused whole, never truncated. */
  | "too_large"
  /**
   * The URL's host is (or resolves to) a non-public address — loopback,
   * link-local, RFC1918/CGNAT, cloud metadata, IPv6 ULA/link-local, etc. The
   * SSRF egress guard refused it PRE-FETCH, so there is no connection, no
   * status, and no connect-refused-vs-response distinction to leak: every
   * blocked address gets this one uniform reason regardless of what (if
   * anything) listens behind it.
   */
  | "blocked_address"
  /**
   * The crawl hit its wall-clock budget before reaching this queued URL. Not a
   * failure of the page — a bound on the crawl. Reported so a time-truncated
   * crawl can never masquerade as a complete one.
   */
  | "budget_exhausted";

/** One attempted URL, in crawl order. */
export interface PageOutcome {
  url: string;
  /** Link depth from the start URL (start = 0). */
  depth: number;
  status: "crawled" | "failed";
  reason?: PageFailureReason;
  /** HTTP status, where a response was received. */
  httpStatus?: number;
  /** Honest human-readable note — what happened at this URL. */
  detail: string;
}

/**
 * The crawl's honesty record. Persisted with the audit (audits.score jsonb)
 * so every stored score carries exactly what it was — and was not — based on.
 */
export interface CrawlCoverage {
  /** URLs attempted (== pages.length; crawled + failed). */
  attempted: number;
  /** URLs successfully crawled and handed to the skill. */
  crawled: number;
  /** Every attempted URL with its outcome, in crawl order. */
  pages: PageOutcome[];
  /** "absent" = 404-class (no robots.txt served — everything allowed). */
  robotsTxtStatus: "fetched" | "absent" | "unreachable";
  llmsTxtStatus: "fetched" | "absent" | "unreachable";
  /** True when same-origin links were discovered beyond maxPages/maxDepth. */
  frontierTruncated: boolean;
  /** Distinct off-origin URLs discovered and REFUSED (never fetched). */
  offOriginRefused: number;
}

/** Crawl output: the skill's input, plus the honesty record. */
export interface CrawlResult {
  /** Exactly what `runAudit` consumes — only successfully crawled pages. */
  site: CrawledSite;
  coverage: CrawlCoverage;
}
