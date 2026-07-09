/**
 * M2 crawl layer — the bounded same-origin crawler (doc 05 M2, doc 07 §1.4).
 *
 * `crawlSite` walks a property breadth-first from its start URL over an
 * INJECTED FetchPort (src/lib/write-methods/shared — the same port discipline
 * as the write methods: tests run on ScriptedFetch with zero live network;
 * production passes the platform `fetch`). Output is exactly what the
 * aeo-audit skill consumes (`CrawledSite`) plus the per-page honesty record
 * (`CrawlCoverage`).
 *
 * Hard rules:
 *  - SAME-ORIGIN ONLY. A discovered link whose origin (scheme+host+port)
 *    differs from the start URL's is counted and REFUSED — never fetched.
 *    Subdomains and scheme changes are different origins on purpose.
 *  - BOUNDED. maxPages / maxDepth / maxPageBytes are hard caps (types.ts).
 *  - ROBOTS RESPECTED. robots.txt is fetched first; paths disallowed for
 *    AEO-AuditBot (via the skill's reusable parser) are recorded as blocked,
 *    not crawled. An UNREACHABLE robots.txt (5xx/network) means the rules are
 *    unknown → nothing is crawled (the robots-spec-conservative reading), and
 *    the coverage record says exactly that.
 *  - REDIRECT/ERROR HONESTY. The port pins `redirect: "error"`; a URL that
 *    redirects or fails is recorded as a per-page failure with its reason —
 *    the crawler never follows a hop and never silently drops a page.
 *  - SSRF-SAFE. Every fetch (the very first robots.txt/llms.txt read AND every
 *    page) passes the egress guard (egress-guard.ts) FIRST: an IP-literal or
 *    resolved-to-internal host (loopback, link-local, RFC1918, cloud metadata,
 *    IPv6 ULA…) is refused pre-fetch. A blocked START host crawls nothing and
 *    records the uniform `blocked_address` reason. DNS is resolved via the
 *    INJECTED `resolvePort` (memoized per host within a crawl) — same
 *    zero-live-dependency discipline as the FetchPort.
 *  - TIME-BOUNDED. `wallClockBudgetMs` ends the crawl early once exceeded;
 *    unreached queued URLs are recorded as `budget_exhausted`. The per-request
 *    timeout is applied at the live-fetch seam (the port carries no signal).
 *  - DETERMINISTIC within budget. BFS in discovery order; `crawledAt` is
 *    caller-supplied; no randomness. The only clock input is the wall-clock
 *    budget (a safety valve): any crawl that completes within budget — the
 *    normal case — is byte-identical across runs. `now` is injectable so the
 *    budget path is exercised deterministically in tests.
 */

import type { CrawledPage, CrawledSite } from "@/lib/skills/aeo-audit";
import { isBotAllowed } from "@/lib/skills/aeo-audit";
import type { FetchPort, FetchPortResponse } from "@/lib/write-methods/shared";
import { checkEgressHost, type ResolvePort } from "./egress-guard";
import { extractDoc } from "./extract";
import {
  AUDIT_CRAWLER_BOT,
  AUDIT_CRAWLER_USER_AGENT,
  DEFAULT_CRAWL_BOUNDS,
  type CrawlBounds,
  type CrawlCoverage,
  type CrawlResult,
  type PageOutcome,
} from "./types";

export interface CrawlInput {
  fetchPort: FetchPort;
  /**
   * Injected DNS resolver for the SSRF egress guard — REQUIRED, no insecure
   * default (production wires node dns behind the live-fetch seam; tests pass a
   * fake). A crawler that could skip the resolve check would silently lose
   * SSRF protection on DNS hostnames.
   */
  resolvePort: ResolvePort;
  /** Absolute http(s) URL of the property (callers validate before invoking). */
  startUrl: string;
  /** ISO timestamp for `site.crawledAt` — caller-supplied (determinism). */
  crawledAt: string;
  bounds?: Partial<CrawlBounds>;
  /** Injectable clock for the wall-clock budget. Default: `Date.now`. */
  now?: () => number;
}

/**
 * Words of extracted visible text below which a scripted page is judged
 * JS-render-invisible (`rendersWithoutJs: false`). Server-HTML heuristic —
 * an SPA shell (`<div id="root"></div>` + bundles) has scripts and next to no
 * text; a genuinely thin static page without scripts stays `true` (thinness
 * is other checks' finding, not JS-invisibility). Headless render comparison
 * is M5's job, not the audit crawl's.
 */
export const RENDER_VISIBLE_MIN_WORDS = 30;

/** Truncation-safe cap for the honest per-page `detail` strings. */
const MAX_DETAIL_CHARS = 200;

/* ------------------------------------------------------------------ */
/* URL handling                                                        */
/* ------------------------------------------------------------------ */

/**
 * Canonical crawl identity: origin + pathname, hash and query dropped,
 * trailing slash stripped (root stays "/"). Matches the skill's own URL
 * identity rules so internal-linking analysis lines up with what we fetched.
 * The audit crawl targets canonical paths — query-variant pages are the same
 * page for rubric purposes.
 */
function canonicalUrl(resolved: URL): string {
  let path = resolved.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return `${resolved.origin}${path}`;
}

const NON_FETCHABLE_SCHEME = /^(?:javascript|mailto|tel|data|blob|about):/i;

type ResolvedLink = { kind: "internal"; url: string } | { kind: "off_origin"; url: string } | { kind: "skip" };

function resolveLink(href: string, pageUrl: string, origin: string): ResolvedLink {
  if (NON_FETCHABLE_SCHEME.test(href.trim())) return { kind: "skip" };
  let resolved: URL;
  try {
    resolved = new URL(href, pageUrl);
  } catch {
    return { kind: "skip" };
  }
  if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return { kind: "skip" };
  if (resolved.origin !== origin) return { kind: "off_origin", url: resolved.origin + resolved.pathname };
  return { kind: "internal", url: canonicalUrl(resolved) };
}

/* ------------------------------------------------------------------ */
/* Fetch helpers                                                       */
/* ------------------------------------------------------------------ */

interface FetchTextOutcome {
  kind: "ok" | "rejected" | "http_error" | "too_large" | "not_html" | "blocked";
  status?: number;
  body?: string;
  contentType?: string | null;
  lastModifiedHeader?: string | null;
}

/** Uniform, non-leaking note for an egress-blocked target (see PageFailureReason). */
const BLOCKED_ADDRESS_DETAIL =
  "This address could not be verified as a public host (loopback, private, link-local, or cloud-metadata range) — refused before any connection by the SSRF egress guard.";

const BUDGET_EXHAUSTED_DETAIL =
  "Crawl wall-clock budget reached before this URL was fetched — reported so a time-truncated crawl is never mistaken for a complete one.";

/** Sanitize a header token for the coverage record (bounded, media-type only). */
function mediaType(contentType: string | null): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase().slice(0, 60);
}

async function fetchText(
  port: FetchPort,
  url: string,
  maxChars: number,
  opts: { requireHtml: boolean },
): Promise<FetchTextOutcome> {
  let response: FetchPortResponse;
  try {
    response = await port(url, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
        "user-agent": AUDIT_CRAWLER_USER_AGENT,
      },
      redirect: "error",
    });
  } catch {
    return { kind: "rejected" };
  }
  const status = response.status;
  const contentType = response.headers.get("content-type");
  if (status < 200 || status >= 300) return { kind: "http_error", status, contentType };
  // Content-Length precheck: refuse a declared-oversized body without reading it.
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxChars) {
    return { kind: "too_large", status, contentType };
  }
  if (opts.requireHtml && contentType !== null && !mediaType(contentType).includes("html")) {
    return { kind: "not_html", status, contentType };
  }
  let body: string;
  try {
    body = await response.text();
  } catch {
    return { kind: "rejected" };
  }
  if (body.length > maxChars) return { kind: "too_large", status, contentType };
  return { kind: "ok", status, body, contentType, lastModifiedHeader: response.headers.get("last-modified") };
}

/**
 * Egress-guarded fetch: run the SSRF check on the URL's host BEFORE touching
 * the port. A blocked host returns `{ kind: "blocked" }` with NO port call — no
 * connection, so nothing to leak. `resolve` is the per-crawl memoized resolver,
 * so a same-origin crawl resolves its host exactly once.
 */
async function guardedFetch(
  port: FetchPort,
  resolve: ResolvePort,
  url: string,
  maxChars: number,
  opts: { requireHtml: boolean },
): Promise<FetchTextOutcome> {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { kind: "rejected" };
  }
  if (!(await checkEgressHost(host, resolve))) return { kind: "blocked" };
  return fetchText(port, url, maxChars, opts);
}

/* ------------------------------------------------------------------ */
/* Page assembly                                                       */
/* ------------------------------------------------------------------ */

function wordCount(s: string): number {
  const trimmed = s.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function buildPage(
  url: string,
  html: string,
  lastModifiedHeader: string | null,
  origin: string,
): { page: CrawledPage; internalLinks: string[]; offOrigin: string[] } {
  const doc = extractDoc(html);

  const internalLinks: string[] = [];
  const internalSeen = new Set<string>();
  const offOrigin: string[] = [];
  for (const href of doc.hrefs) {
    const link = resolveLink(href, url, origin);
    if (link.kind === "internal" && !internalSeen.has(link.url)) {
      internalSeen.add(link.url);
      internalLinks.push(link.url);
    } else if (link.kind === "off_origin") {
      offOrigin.push(link.url);
    }
  }

  // Last-modified signal: JSON-LD dateModified beats the HTTP header (the
  // header often reflects deploys, not edits); header only when parseable.
  let lastModified: string | null = doc.jsonLdDateModified;
  if (lastModified === null && lastModifiedHeader !== null) {
    const ms = Date.parse(lastModifiedHeader);
    if (!Number.isNaN(ms)) lastModified = new Date(ms).toISOString();
  }

  const page: CrawledPage = {
    url,
    title: doc.title,
    metaDescription: doc.metaDescription,
    h1s: doc.h1s,
    visibleText: doc.visibleText,
    jsonLdBlocks: doc.jsonLdBlocks,
    images: doc.images,
    internalLinks,
    hasVideo: doc.hasVideo,
    hasTranscript: doc.hasTranscriptMarker,
    lastModified,
    rendersWithoutJs: wordCount(doc.visibleText) >= RENDER_VISIBLE_MIN_WORDS || !doc.hasScripts,
    // faqItems deliberately OMITTED: the skill's FAQ check falls back to
    // FAQPage JSON-LD when absent (its documented contract). DOM-level Q/A
    // pair extraction without a real parser would fabricate structure —
    // honesty over guessed pairs; revisit with a rendering pipeline.
  };
  return { page, internalLinks, offOrigin };
}

/* ------------------------------------------------------------------ */
/* The crawler                                                         */
/* ------------------------------------------------------------------ */

export async function crawlSite(input: CrawlInput): Promise<CrawlResult> {
  const bounds: CrawlBounds = { ...DEFAULT_CRAWL_BOUNDS, ...input.bounds };
  const now = input.now ?? Date.now;
  const startedAt = now();
  let start: URL;
  try {
    start = new URL(input.startUrl);
  } catch {
    throw new Error("crawlSite: startUrl must be an absolute http(s) URL");
  }
  if (start.protocol !== "http:" && start.protocol !== "https:") {
    throw new Error("crawlSite: startUrl must be an absolute http(s) URL");
  }
  const origin = start.origin;
  const startCanonical = canonicalUrl(start);

  // Per-crawl DNS memo: the egress guard resolves each host once, so a
  // same-origin crawl (every fetch shares the start host) does a single lookup.
  const resolveCache = new Map<string, Promise<Awaited<ReturnType<ResolvePort>>>>();
  const resolveMemo: ResolvePort = (host) => {
    let pending = resolveCache.get(host);
    if (pending === undefined) {
      pending = input.resolvePort(host);
      resolveCache.set(host, pending);
    }
    return pending;
  };

  // robots.txt first — this is ALSO the first egress check on the property
  // host. A blocked host stops here: fetch nothing, record the start URL under
  // the uniform `blocked_address` reason (no status leak), crawl nothing.
  const robotsOutcome = await guardedFetch(input.fetchPort, resolveMemo, `${origin}/robots.txt`, bounds.maxPageBytes, {
    requireHtml: false,
  });
  if (robotsOutcome.kind === "blocked") {
    return {
      site: { baseUrl: origin, crawledAt: input.crawledAt, pages: [], robotsTxt: null, llmsTxt: null },
      coverage: {
        attempted: 1,
        crawled: 0,
        pages: [
          { url: startCanonical, depth: 0, status: "failed", reason: "blocked_address", detail: BLOCKED_ADDRESS_DETAIL },
        ],
        robotsTxtStatus: "unreachable",
        llmsTxtStatus: "unreachable",
        frontierTruncated: false,
        offOriginRefused: 0,
      },
    };
  }
  let robotsTxt: string | null = null;
  let robotsTxtStatus: CrawlCoverage["robotsTxtStatus"];
  let robotsUnavailable = false;
  if (robotsOutcome.kind === "ok") {
    robotsTxt = robotsOutcome.body ?? "";
    robotsTxtStatus = "fetched";
  } else if (robotsOutcome.kind === "http_error" && robotsOutcome.status !== undefined && robotsOutcome.status < 500) {
    // 4xx-class: the site serves no robots.txt — everything is allowed.
    robotsTxtStatus = "absent";
  } else {
    // 5xx / network / oversized: the rules are UNKNOWN. Crawling anyway would
    // be dishonest politeness — record it and crawl nothing.
    robotsTxtStatus = "unreachable";
    robotsUnavailable = true;
  }

  const llmsOutcome = await guardedFetch(input.fetchPort, resolveMemo, `${origin}/llms.txt`, bounds.maxPageBytes, {
    requireHtml: false,
  });
  const llmsTxt = llmsOutcome.kind === "ok" ? (llmsOutcome.body ?? "") : null;
  const llmsTxtStatus: CrawlCoverage["llmsTxtStatus"] =
    llmsOutcome.kind === "ok"
      ? "fetched"
      : llmsOutcome.kind === "http_error" && llmsOutcome.status !== undefined && llmsOutcome.status < 500
        ? "absent"
        : "unreachable";

  const pages: CrawledPage[] = [];
  const outcomes: PageOutcome[] = [];
  const offOriginSeen = new Set<string>();
  /** True when a discovered link was NOT followed because of maxDepth. */
  let depthTruncated = false;
  /** True when the crawl ended early on the wall-clock budget. */
  let budgetExhausted = false;

  const queue: Array<{ url: string; depth: number }> = [{ url: startCanonical, depth: 0 }];
  const seen = new Set<string>([startCanonical]);

  while (queue.length > 0 && outcomes.length < bounds.maxPages) {
    // Wall-clock budget: end the crawl before starting another fetch once the
    // budget is spent. Remaining queued URLs are drained below as
    // `budget_exhausted` — never silently dropped.
    if (now() - startedAt >= bounds.wallClockBudgetMs) {
      budgetExhausted = true;
      break;
    }
    const { url, depth } = queue.shift()!;
    const path = new URL(url).pathname;

    if (robotsUnavailable) {
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "robots_unavailable",
        detail: "robots.txt could not be read (server error or no response) — crawl rules unknown, page not fetched.",
      });
      continue;
    }
    if (!isBotAllowed(robotsTxt, AUDIT_CRAWLER_BOT, path)) {
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "robots_disallowed",
        detail: `robots.txt disallows ${AUDIT_CRAWLER_BOT} from ${path} — block honored, page not fetched.`,
      });
      continue;
    }

    const fetched = await guardedFetch(input.fetchPort, resolveMemo, url, bounds.maxPageBytes, { requireHtml: true });
    if (fetched.kind === "blocked") {
      // Defense in depth: a same-origin crawl can only reach the already-vetted
      // start host, but if a URL's host ever resolves to a blocked address it is
      // recorded uniformly and never fetched.
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "blocked_address",
        detail: BLOCKED_ADDRESS_DETAIL,
      });
      continue;
    }
    if (fetched.kind === "rejected") {
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "fetch_failed",
        detail:
          "No response at this exact URL — network failure or a redirect (the audit crawler never follows redirects).",
      });
      continue;
    }
    if (fetched.kind === "http_error") {
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "http_error",
        httpStatus: fetched.status,
        detail: `HTTP ${fetched.status} — page not crawlable.`.slice(0, MAX_DETAIL_CHARS),
      });
      continue;
    }
    if (fetched.kind === "too_large") {
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "too_large",
        httpStatus: fetched.status,
        detail: `Body exceeds the ${bounds.maxPageBytes}-byte page cap — refused whole rather than scored truncated.`,
      });
      continue;
    }
    if (fetched.kind === "not_html") {
      outcomes.push({
        url,
        depth,
        status: "failed",
        reason: "not_html",
        httpStatus: fetched.status,
        detail: `Content-type "${mediaType(fetched.contentType ?? null)}" is not HTML — skipped.`.slice(
          0,
          MAX_DETAIL_CHARS,
        ),
      });
      continue;
    }

    const { page, internalLinks, offOrigin } = buildPage(
      url,
      fetched.body ?? "",
      fetched.lastModifiedHeader ?? null,
      origin,
    );
    pages.push(page);
    outcomes.push({ url, depth, status: "crawled", httpStatus: fetched.status, detail: "Crawled." });
    for (const refused of offOrigin) offOriginSeen.add(refused);
    for (const link of internalLinks) {
      if (seen.has(link)) continue;
      if (depth + 1 > bounds.maxDepth) {
        depthTruncated = true; // an unvisited page exists past the depth cap — say so
        continue;
      }
      seen.add(link);
      queue.push({ url: link, depth: depth + 1 });
    }
  }

  // Budget hit mid-crawl: record the queued-but-unreached URLs honestly (still
  // respecting maxPages, so `attempted` never exceeds its cap; anything left
  // beyond that surfaces as frontier truncation below).
  if (budgetExhausted) {
    while (queue.length > 0 && outcomes.length < bounds.maxPages) {
      const { url, depth } = queue.shift()!;
      outcomes.push({ url, depth, status: "failed", reason: "budget_exhausted", detail: BUDGET_EXHAUSTED_DETAIL });
    }
  }

  const site: CrawledSite = {
    baseUrl: origin,
    crawledAt: input.crawledAt,
    pages,
    robotsTxt,
    llmsTxt,
  };
  const coverage: CrawlCoverage = {
    attempted: outcomes.length,
    crawled: pages.length,
    pages: outcomes,
    robotsTxtStatus,
    llmsTxtStatus,
    frontierTruncated: queue.length > 0 || depthTruncated,
    offOriginRefused: offOriginSeen.size,
  };
  return { site, coverage };
}
