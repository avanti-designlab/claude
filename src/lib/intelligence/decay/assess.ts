/**
 * M6 Content decay / freshness engine — the pure assessment core (doc 05 M6).
 *
 * `assessDecay` takes a crawled site (`CrawledSite` — the frozen skill's page
 * shape, filled by the guarded crawl layer) plus the crawl's coverage record,
 * and returns a per-page decay assessment + a prioritized refresh worklist.
 *
 * PURE + DETERMINISTIC: no network, no DB, no wall-clock. Every age is measured
 * against `site.crawledAt` (never `Date.now`), exactly like the aeo-audit
 * freshness check — so a decay report is byte-identical across re-runs of the
 * same crawl. No randomness.
 *
 * SIGNAL PROVENANCE (what is real vs. what the spec names but the crawl can't give):
 *   REAL — used here, straight from the crawl:
 *     • age, from `page.lastModified` (JSON-LD dateModified ▸ Last-Modified
 *       header — the crawler's precedence, reused not re-derived);
 *     • missing last-modified → age_unknown (honesty, below);
 *     • future-dated last-modified (suspect);
 *     • stale dated statistics in `page.visibleText`;
 *     • thin content, from visible word count.
 *   NOT AVAILABLE — named by doc 05 M6 but NOT fabricated (do not invent
 *   signals the crawl didn't capture):
 *     • "declining internal-link freshness" — a TREND needs decay HISTORY,
 *       which the frozen schema cannot persist (no page-level decay store — see
 *       the module README gap flag); static orphan/inbound analysis is the
 *       aeo-audit `internal_linking` check's domain, not re-implemented here.
 *     • "dead facts" beyond dated statistics — needs external verification / NLP
 *       the server-HTML crawl does not do; dated-statistics detection is the
 *       honest available proxy.
 *     • sitemap `lastmod` — the crawler fills `lastModified` from JSON-LD +
 *       Last-Modified header only, so sitemap lastmod is a documented crawl gap.
 */

import type { CrawledPage, CrawledSite } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import {
  AGE_AGING_MAX_POINTS,
  AGE_STALE_MAX_POINTS,
  DECAY_REFRESH_WINDOW_DAYS,
  FUTURE_DATED_POINTS,
  STALE_STAT_MIN_AGE_YEARS,
  STALE_STAT_POINTS,
  STALE_THRESHOLD_MULTIPLIER,
  THIN_CONTENT_MIN_WORDS,
  THIN_CONTENT_POINTS,
  type DecayOptions,
  type DecayReport,
  type DecaySignal,
  type DecayStatus,
  type DecaySummary,
  type PageDecayAssessment,
} from "./types";

/* ------------------------------------------------------------------ */
/* Minimal date/text helpers                                           */
/* ------------------------------------------------------------------ */

/**
 * Whole (fractional) days from `fromIso` to `toIso`; positive when `toIso` is
 * later. null when either side is unparsable. Deliberate local mirror of the
 * aeo-audit `util.daysBetween` (its util is not on the skill's public barrel,
 * and skill internals are out of this module's scope) — semantics kept
 * identical so decay ages match the audit's freshness ages exactly.
 */
function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return (to - from) / 86_400_000;
}

/** Word count of visible text (mirror of the skill's util.wordCount). */
function wordCount(s: string): number {
  const trimmed = s.trim();
  return trimmed === "" ? 0 : trimmed.split(/\s+/).length;
}

function clamp(n: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

/**
 * Stale dated-statistic pattern — kept in sync with the aeo-audit freshness
 * check's `DATED_STAT` (that regex is module-private there; replicated here
 * deliberately so decay's staleness reading matches the audit's). Global so all
 * matches on a page are found; `lastIndex` is reset before every use.
 */
const DATED_STAT =
  /\b(as of|updated(?: on| in)?|data from|statistics from|figures from|survey from)\s+((?:19|20)\d{2})\b/gi;

/* ------------------------------------------------------------------ */
/* Age → decay component                                               */
/* ------------------------------------------------------------------ */

/**
 * Age component of the decay score (0–100), for a KNOWN, non-future age.
 * Piecewise + monotonic in age (older ⇒ higher), deterministic:
 *   • within window                 → 0
 *   • window..staleThreshold        → linear 0..AGE_AGING_MAX_POINTS
 *   • past staleThreshold           → AGE_AGING_MAX_POINTS..AGE_STALE_MAX_POINTS,
 *                                     reaching the ceiling at 2× staleThreshold
 */
function ageComponent(ageDays: number, windowDays: number, staleDays: number): number {
  if (ageDays <= windowDays) return 0;
  if (ageDays <= staleDays) {
    const span = staleDays - windowDays;
    const frac = span <= 0 ? 1 : (ageDays - windowDays) / span;
    return AGE_AGING_MAX_POINTS * frac;
  }
  const overStale = staleDays <= 0 ? 1 : Math.min(1, (ageDays - staleDays) / staleDays);
  return AGE_AGING_MAX_POINTS + (AGE_STALE_MAX_POINTS - AGE_AGING_MAX_POINTS) * overStale;
}

/* ------------------------------------------------------------------ */
/* Per-page assessment                                                 */
/* ------------------------------------------------------------------ */

function assessPage(page: CrawledPage, crawledAt: string, windowDays: number, staleDays: number): PageDecayAssessment {
  const signals: DecaySignal[] = [];
  let contentPoints = 0;

  /* --- content signals (independent of age) ------------------------ */
  const staleStatYears = staleStatMatches(page.visibleText, crawledAt);
  if (staleStatYears.length > 0) {
    contentPoints += STALE_STAT_POINTS;
    signals.push({
      kind: "stale_dated_statistic",
      detail: `Dated ${pluralize(staleStatYears.length, "statistic")} ≥ ${STALE_STAT_MIN_AGE_YEARS}y old in the copy (${staleStatYears
        .map((m) => `"${m}"`)
        .join(", ")}) — verify and refresh.`,
      points: STALE_STAT_POINTS,
    });
  }
  const words = wordCount(page.visibleText);
  if (words < THIN_CONTENT_MIN_WORDS) {
    contentPoints += THIN_CONTENT_POINTS;
    signals.push({
      kind: "thin_content",
      detail: `Thin content — ${pluralize(words, "visible word")} (< ${THIN_CONTENT_MIN_WORDS}); too little substance to demonstrate freshness or usefulness.`,
      points: THIN_CONTENT_POINTS,
    });
  }

  /* --- age axis ---------------------------------------------------- */
  const ageRaw = page.lastModified === null ? null : daysBetween(page.lastModified, crawledAt);

  // No usable last-modified signal (absent OR unparsable): age is UNKNOWN.
  // Never fresh, never stale, never a fabricated age. The page may still carry
  // content decay (scored above); the age component is simply absent.
  if (page.lastModified === null || ageRaw === null) {
    signals.push({
      kind: "no_last_modified",
      detail:
        page.lastModified === null
          ? "No last-modified signal (JSON-LD dateModified / Last-Modified header) — freshness cannot be demonstrated to engines."
          : `Unparsable last-modified value "${page.lastModified}" — treated as no usable signal; age not assumed.`,
      points: 0,
    });
    // Score reflects ONLY observed content decay; the age component is absent
    // (never fabricated). No content decay ⇒ null, honestly "can't score".
    const decayScore = contentPoints > 0 ? round1(clamp(contentPoints)) : null;
    return {
      url: page.url,
      status: "age_unknown",
      decayScore,
      ageDays: null,
      lastModified: page.lastModified,
      signals,
      recommendation:
        "Expose a real last-modified signal (schema dateModified / sitemap lastmod) reflecting the TRUE last edit — never a cosmetic bump. Freshness can't be demonstrated without it." +
        (contentPoints > 0 ? " The page also shows content decay above — fold a genuine refresh into the same edit." : ""),
    };
  }

  // Future-dated: last-modified is AFTER the crawl. Suspect data (clock skew,
  // CMS misconfig, or cosmetic date-bumping — the exact thing M6 prohibits).
  // Flagged, NOT counted fresh.
  if (ageRaw < 0) {
    const aheadDays = Math.round(-ageRaw);
    signals.push({
      kind: "future_dated",
      detail: `last-modified "${page.lastModified}" is ${pluralize(aheadDays, "day")} AFTER the crawl — a future-dated signal is suspect, not freshness.`,
      points: FUTURE_DATED_POINTS,
    });
    return {
      url: page.url,
      status: "suspect_future_dated",
      decayScore: round1(clamp(FUTURE_DATED_POINTS + contentPoints)),
      ageDays: null,
      lastModified: page.lastModified,
      signals,
      recommendation:
        "Correct the last-modified to the REAL last-edit date (schema dateModified / sitemap lastmod). dateModified is set only where real edits were made — cosmetic date-bumping is prohibited.",
    };
  }

  const ageDays = Math.round(ageRaw);
  const agePoints = ageComponent(ageRaw, windowDays, staleDays);
  let status: DecayStatus;
  if (ageRaw <= windowDays) {
    status = "fresh";
  } else if (ageRaw <= staleDays) {
    status = "aging";
    signals.push({
      kind: "past_refresh_window",
      detail: `${pluralize(ageDays, "day")} old — past the ${windowDays}-day refresh window (under the ${staleDays}-day stale threshold).`,
      points: round1(agePoints),
    });
  } else {
    status = "stale";
    signals.push({
      kind: "past_stale_threshold",
      detail: `${pluralize(ageDays, "day")} old — past the ${staleDays}-day stale threshold; reads as unmaintained to engines.`,
      points: round1(agePoints),
    });
  }

  const decayScore = round1(clamp(agePoints + contentPoints));
  return {
    url: page.url,
    status,
    decayScore,
    ageDays,
    lastModified: page.lastModified,
    signals,
    recommendation: recommendationFor(status, contentPoints > 0),
  };
}

/** All stale dated-stat phrases on a page (bounded, deterministic). */
function staleStatMatches(visibleText: string, crawledAt: string): string[] {
  const crawlYear = new Date(crawledAt).getUTCFullYear();
  if (!Number.isFinite(crawlYear)) return [];
  const found: string[] = [];
  DATED_STAT.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DATED_STAT.exec(visibleText)) !== null) {
    const year = Number(match[2]);
    if (crawlYear - year >= STALE_STAT_MIN_AGE_YEARS && !found.includes(match[0])) {
      found.push(match[0]);
    }
  }
  return found;
}

function recommendationFor(status: DecayStatus, hasContentDecay: boolean): string {
  const refreshLine =
    "Queue a genuine content refresh (updated facts, stats, examples) through the content pipeline. dateModified is updated ONLY where real edits were made — cosmetic date-bumping is prohibited.";
  if (status === "stale") return `Refresh first — ${refreshLine}`;
  if (status === "aging") {
    return hasContentDecay
      ? `Refresh — past the window and carrying stale/thin content. ${refreshLine}`
      : `Review — approaching staleness. ${refreshLine}`;
  }
  // fresh
  return hasContentDecay
    ? `Within the refresh window, but carrying stale/thin content — spot-fix those. dateModified only where real edits were made.`
    : "Within the refresh window — no refresh needed.";
}

/** A page belongs on the "refresh these first" content worklist. Age-unknown
 *  and future-dated pages need METADATA fixes (see decay-to-plan), not a
 *  content rewrite, so they are NOT queued here unless they ALSO carry content
 *  decay. */
function needsContentRefresh(p: PageDecayAssessment): boolean {
  if (p.status === "stale" || p.status === "aging") return true;
  // fresh / age_unknown / suspect_future_dated: only if a content signal fired.
  return p.signals.some((s) => s.kind === "stale_dated_statistic" || s.kind === "thin_content");
}

/* ------------------------------------------------------------------ */
/* Public entry                                                        */
/* ------------------------------------------------------------------ */

/**
 * Assess content decay across a crawled site. Only successfully-crawled pages
 * (`site.pages`) are assessed; `coverage` supplies the honest count of pages
 * that could NOT be crawled, which are excluded and reported as excluded.
 */
export function assessDecay(
  site: CrawledSite,
  coverage: CrawlCoverage,
  options: DecayOptions = {}
): DecayReport {
  const windowDays =
    typeof options.refreshWindowDays === "number" && Number.isFinite(options.refreshWindowDays) && options.refreshWindowDays > 0
      ? options.refreshWindowDays
      : DECAY_REFRESH_WINDOW_DAYS;
  const staleDays = windowDays * STALE_THRESHOLD_MULTIPLIER;

  const pages = site.pages.map((page) => assessPage(page, site.crawledAt, windowDays, staleDays));

  // "Refresh these first": worst decay first, deterministic tiebreak on URL.
  const refreshQueue = pages
    .filter(needsContentRefresh)
    .slice()
    .sort((a, b) => (b.decayScore ?? 0) - (a.decayScore ?? 0) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));

  const summary: DecaySummary = {
    assessed: pages.length,
    fresh: pages.filter((p) => p.status === "fresh").length,
    aging: pages.filter((p) => p.status === "aging").length,
    stale: pages.filter((p) => p.status === "stale").length,
    ageUnknown: pages.filter((p) => p.status === "age_unknown").length,
    suspectFutureDated: pages.filter((p) => p.status === "suspect_future_dated").length,
    withStaleStats: pages.filter((p) => p.signals.some((s) => s.kind === "stale_dated_statistic")).length,
    thin: pages.filter((p) => p.signals.some((s) => s.kind === "thin_content")).length,
    uncrawlableExcluded: Math.max(coverage.attempted - coverage.crawled, 0),
  };

  return {
    baseUrl: site.baseUrl,
    crawledAt: site.crawledAt,
    refreshWindowDays: windowDays,
    staleThresholdDays: staleDays,
    pages,
    refreshQueue,
    summary,
  };
}
