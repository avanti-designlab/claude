/**
 * M6 Content decay / freshness engine — types + thresholds (doc 05 M6,
 * doc 07 §1.4).
 *
 * M6 assesses a property's CRAWLED pages (via the guarded crawl layer — the
 * same input surface M2 uses) and produces a per-page decay signal plus a
 * prioritized "refresh these first" worklist. It scores the frozen skill's
 * page shape (`CrawledPage`), reusing the crawler's already-extracted
 * `lastModified` (JSON-LD `dateModified` beats the `Last-Modified` header, the
 * crawler's documented precedence — NOT re-derived here) and the page's
 * visible text; it invents no signal the crawl did not capture.
 *
 * HONESTY, non-negotiable (doc 05 M6, task brief):
 *  - A page with NO discoverable last-modified signal is `age_unknown` —
 *    NEVER "stale" and NEVER "fresh". Its age is never fabricated. Age is its
 *    own categorical axis, orthogonal to the numeric decay score.
 *  - A page that could not be crawled is EXCLUDED from the assessment and
 *    reported as excluded (from the crawl coverage record) — never assessed
 *    from absent data.
 *  - Every decay threshold below is a DOC-SILENT engineering choice (doc 02/05
 *    give no decay cadence, and the playbook schema carries no refresh-window
 *    field — the same gap the aeo-audit freshness check flagged). They are
 *    documented loudly here and belong on the launch-threshold ⚑ ratification
 *    list (BUILD-STATE) alongside the aeo-audit refresh-window default.
 */

import { DEFAULT_REFRESH_WINDOW_DAYS } from "@/lib/skills/aeo-audit";

/* ------------------------------------------------------------------ */
/* Thresholds — DOC-SILENT engineering choices (⚑ launch-ratify)       */
/* ------------------------------------------------------------------ */

/**
 * Refresh window (days). Pages older than this have entered the decay curve.
 * REUSED from the aeo-audit skill's `DEFAULT_REFRESH_WINDOW_DAYS` (90) so the
 * decay engine and the audit's freshness check share ONE default and cannot
 * drift. Doc 05 gives real-estate "60–90 days"; the real cadence is vertical-
 * and client-specific. The playbook schema has no per-vertical refresh field
 * yet (escalated with the aeo-audit skill) — until it does, this default holds
 * and is overridable per scan. ⚑ Launch-threshold flag.
 */
export const DECAY_REFRESH_WINDOW_DAYS = DEFAULT_REFRESH_WINDOW_DAYS;

/**
 * A page past `refreshWindow × this` is `stale` (urgent) rather than merely
 * `aging`. 2× the window (default 180d) is the boundary between "review soon"
 * and "reads as unmaintained to engines". ⚑ Doc-silent launch-threshold flag.
 */
export const STALE_THRESHOLD_MULTIPLIER = 2;

/**
 * Below this visible word count a content page reads as THIN — a decay-adjacent
 * signal (a page too thin to demonstrate freshness or usefulness). Distinct
 * from the crawler's `RENDER_VISIBLE_MIN_WORDS` (30), which is about JS-render
 * INVISIBILITY, not editorial thinness. ⚑ Doc-silent launch-threshold flag.
 */
export const THIN_CONTENT_MIN_WORDS = 150;

/**
 * A dated statistic in visible text ("as of 2019", "data from 2020") this many
 * years or more before the crawl year is stale. Matches the aeo-audit freshness
 * check's staleness cutoff (kept in sync deliberately). ⚑ Launch-threshold flag.
 */
export const STALE_STAT_MIN_AGE_YEARS = 2;

/* --- Decay-score component weights (0–100 scale) --------------------- */

/** Max points the age component contributes while a page is merely `aging`
 *  (reached exactly at the stale threshold). ⚑ Doc-silent. */
export const AGE_AGING_MAX_POINTS = 55;
/** Age component ceiling once a page is past the stale threshold (reached at
 *  2× the stale threshold). ⚑ Doc-silent. */
export const AGE_STALE_MAX_POINTS = 100;
/** Fixed age-component points for a suspect FUTURE-dated page — flagged, never
 *  rewarded as fresh (mirrors the aeo-audit "medium" correction). ⚑ Doc-silent. */
export const FUTURE_DATED_POINTS = 40;
/** Points added when a page carries one or more stale dated statistics. ⚑ Doc-silent. */
export const STALE_STAT_POINTS = 20;
/** Points added when a page's visible text is below THIN_CONTENT_MIN_WORDS. ⚑ Doc-silent. */
export const THIN_CONTENT_POINTS = 15;

/**
 * One flat, greppable registry of every doc-silent decay threshold, for the
 * launch-ratification surface. The engine reads the individual constants; this
 * exists so the ⚑ list has a single source (mirrors how the crawl bounds are
 * flagged in one place).
 */
export const DECAY_THRESHOLD_FLAGS = {
  DECAY_REFRESH_WINDOW_DAYS,
  STALE_THRESHOLD_MULTIPLIER,
  THIN_CONTENT_MIN_WORDS,
  STALE_STAT_MIN_AGE_YEARS,
  AGE_AGING_MAX_POINTS,
  AGE_STALE_MAX_POINTS,
  FUTURE_DATED_POINTS,
  STALE_STAT_POINTS,
  THIN_CONTENT_POINTS,
} as const;

/* ------------------------------------------------------------------ */
/* Per-page assessment                                                 */
/* ------------------------------------------------------------------ */

/**
 * Categorical freshness state. `age_unknown` and `suspect_future_dated` are
 * FIRST-CLASS categories — never collapsed into fresh/stale — so the product
 * can render "we can't verify this page's age" honestly instead of guessing.
 */
export type DecayStatus =
  /** Age known and within the refresh window. */
  | "fresh"
  /** Past the refresh window but under the stale threshold. */
  | "aging"
  /** Past the stale threshold — reads as unmaintained. */
  | "stale"
  /** last-modified is LATER than the crawl — suspect data, NOT fresh. */
  | "suspect_future_dated"
  /** No usable last-modified signal — freshness cannot be determined. NOT fresh, NOT stale. */
  | "age_unknown";

/** A concrete decay signal actually observed on the page (the WHY). */
export type DecaySignalKind =
  | "past_refresh_window"
  | "past_stale_threshold"
  | "future_dated"
  | "no_last_modified"
  | "stale_dated_statistic"
  | "thin_content";

export interface DecaySignal {
  kind: DecaySignalKind;
  /** Evidence-bearing, human-readable note (age in days, the dated phrase, word count…). */
  detail: string;
  /** Points this signal contributed to `decayScore` (full transparency of the number). */
  points: number;
}

export interface PageDecayAssessment {
  url: string;
  status: DecayStatus;
  /**
   * 0–100, higher = more decayed. `null` ONLY when nothing is assessable —
   * `age_unknown` AND no content signal. A null score is honest ("we can't
   * score this"), never a fabricated 0 that would read as fresh.
   */
  decayScore: number | null;
  /** Whole days old at crawl time; null when age is unknown/unparsable. Never invented. */
  ageDays: number | null;
  /** The last-modified value the crawl used (JSON-LD dateModified > header), or null. */
  lastModified: string | null;
  /** Signals observed on this page, in deterministic order. */
  signals: DecaySignal[];
  /** One actionable recommendation (what to do), in interface voice. */
  recommendation: string;
}

/* ------------------------------------------------------------------ */
/* Report                                                              */
/* ------------------------------------------------------------------ */

export interface DecaySummary {
  /** Pages assessed (== crawled pages handed in). */
  assessed: number;
  fresh: number;
  aging: number;
  stale: number;
  ageUnknown: number;
  suspectFutureDated: number;
  withStaleStats: number;
  thin: number;
  /**
   * Pages the crawl could NOT read (attempted − crawled, from coverage). They
   * are excluded from `pages`/`refreshQueue` — reported here so a partial scan
   * never masquerades as a whole-site assessment.
   */
  uncrawlableExcluded: number;
}

export interface DecayReport {
  baseUrl: string;
  /** The crawl timestamp all ages are measured against (NEVER wall-clock). */
  crawledAt: string;
  refreshWindowDays: number;
  staleThresholdDays: number;
  /** Every crawled page's assessment, in crawl order (excludes uncrawlable pages by construction). */
  pages: PageDecayAssessment[];
  /**
   * Pages recommended for a CONTENT refresh, WORST DECAY FIRST — the operator's
   * "refresh these first" worklist. Age-unknown pages with no content decay are
   * NOT here (they need a metadata signal, not a rewrite — see the plan fixes).
   */
  refreshQueue: PageDecayAssessment[];
  summary: DecaySummary;
}

export interface DecayOptions {
  /** Override the refresh window (days). Default: DECAY_REFRESH_WINDOW_DAYS. */
  refreshWindowDays?: number;
}
