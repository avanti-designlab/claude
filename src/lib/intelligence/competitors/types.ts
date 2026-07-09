/**
 * M4 Competitor citation reverse-engineering — types (doc 05 §M4; doc 07 §1.4).
 *
 * M4 answers "they're cited and you're not — WHY, and what do you do about it".
 * Its input is the competitor cited-URL set that M3 already measured and stored
 * (share-of-voice / cited-URL inventory, `visibility_results`); M4 never
 * re-samples citations (that is M3's job). It crawls each competitor cited URL
 * through the SHARED, egress-guarded M2 crawler, scores it with the SAME frozen
 * aeo-audit rubric, and diffs the scored competitors against the client's own
 * audit to produce an evidence-backed, prioritized "citation gap" list.
 *
 * HONESTY IS THE FEATURE (competitive analysis lives or dies on it):
 *  - Every gap claim traces to a crawled competitor page + the skill's rubric
 *    output. No invented competitor data, ever.
 *  - A competitor URL that could not be crawled (SSRF-blocked, robots-blocked,
 *    unreachable, or not a crawlable web target) is EXCLUDED from every
 *    "N of M competitors" denominator and SAID so — never silently counted as
 *    "does not have the signal".
 *  - A gap asserted from a single crawlable competitor reports n=1 explicitly.
 */

import type { AuditFix, AuditResult, CheckId } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { VisibilityEngine } from "@/lib/types/db";

/* ------------------------------------------------------------------ */
/* Input — a competitor citation to reverse-engineer                   */
/* ------------------------------------------------------------------ */

/**
 * One competitor cited-source to analyze, derived from M3's cited-URL
 * inventory (`CitedUrlEntry` with attribution === "competitor"). Passed IN to
 * M4 — M4 does not sample citations.
 */
export interface CompetitorTarget {
  /** The cited source verbatim, exactly as the engine returned it (M3). */
  citedUrl: string;
  /** Normalized registrable host (M3), or null when the source wasn't URL-shaped. */
  domain: string | null;
  /** The competitor's name from M3 attribution (null when only a domain matched). */
  name: string | null;
  /** Times this source was cited in the run — evidence weight, not a gap signal. */
  citationCount: number;
  /** Engines that cited this source, in canonical order (M3). */
  engines: VisibilityEngine[];
}

/* ------------------------------------------------------------------ */
/* Crawl + score outcome per competitor                                */
/* ------------------------------------------------------------------ */

/**
 * Why a competitor was EXCLUDED from the gap denominators. Every reason means
 * "we obtained no rubric signal for this competitor" — so it is never counted
 * as an absence of signal, only as an absence of observation.
 */
export type CompetitorExclusionReason =
  /** The cited source could not be turned into an http(s) crawl target. */
  | "not_crawlable_url"
  /** The SSRF egress guard refused the host (internal/loopback/metadata/...). */
  | "blocked_address"
  /** robots.txt disallowed our bot, or was unreachable → nothing crawled. */
  | "robots_blocked"
  /** Every fetch failed / errored / was non-HTML → nothing crawled. */
  | "unreachable";

/** One competitor after crawl + score (or the honest reason it was excluded). */
export interface CompetitorCrawlResult {
  target: CompetitorTarget;
  /** The http(s) URL actually crawled; null when no crawl was attempted. */
  crawlUrl: string | null;
  status: "scored" | "excluded";
  /** The rubric result — present iff status === "scored". */
  audit: AuditResult | null;
  /** Per-page crawl honesty — present iff a crawl was attempted. */
  coverage: CrawlCoverage | null;
  /** Why excluded — present iff status === "excluded". */
  exclusionReason: CompetitorExclusionReason | null;
}

/* ------------------------------------------------------------------ */
/* The gap report                                                      */
/* ------------------------------------------------------------------ */

/** A single competitor's standing on one rubric check (gap evidence). */
export interface CompetitorSignalEvidence {
  name: string | null;
  citedUrl: string;
  /** The competitor's 0–100 score on the check. */
  score: number;
}

/**
 * One evidence-backed citation gap: a rubric check on which the client has an
 * actionable fix AND at least one crawlable cited competitor demonstrably LEADS
 * the client (see gap-diff thresholds). The client's own audit fix(es) for the
 * check are the concrete "do Y".
 */
export interface CitationGap {
  checkId: CheckId;
  /** Canonical check name, from the client's own audit (never re-worded). */
  checkName: string;
  /**
   * N — crawlable cited competitors that LEAD the client on this check. Never
   * counts an uncrawlable competitor.
   */
  competitorsLeading: number;
  /**
   * M — crawlable cited competitors where this check was scored for BOTH the
   * competitor AND the client, so a lead/no-lead comparison was possible.
   * Excludes uncrawlable competitors and competitors whose check was skipped.
   */
  competitorsCompared: number;
  /** The client's 0–100 score on this check — the "you don't". */
  clientScore: number;
  /** The competitors that lead (name, cited URL, score). */
  leaders: CompetitorSignalEvidence[];
  /** Every compared competitor (leaders and not), for full auditability. */
  compared: CompetitorSignalEvidence[];
  /** The client's own gap-closing fix(es) for this check — the "do Y", verbatim. */
  fixes: AuditFix[];
  /** Honest, evidence-backed one-liner ("N of M ... ; your score is X"). */
  summary: string;
}

/** A competitor excluded from ALL denominators, with its reason (honesty). */
export interface ExcludedCompetitor {
  name: string | null;
  citedUrl: string;
  reason: CompetitorExclusionReason;
}

/** Per-competitor provenance — the evidence trail behind the denominators. */
export interface CompetitorCrawlSummary {
  name: string | null;
  citedUrl: string;
  crawlUrl: string | null;
  status: "scored" | "excluded";
  /** Overall rubric score when scored; null when excluded. */
  overallScore: number | null;
  /** Pages successfully crawled when scored; null when excluded. */
  pagesCrawled: number | null;
  exclusionReason: CompetitorExclusionReason | null;
}

export interface CompetitorGapReport {
  playbookVertical: string;
  playbookVersion: string;
  /** ISO timestamp of the analysis (caller-supplied — keeps the diff pure). */
  analyzedAt: string;
  /** Competitors crawled + scored (the denominator-eligible set). */
  competitorsScored: number;
  /** Competitors excluded from ALL denominators, each with its reason. */
  excluded: ExcludedCompetitor[];
  /** Prioritized citation gaps (highest-consistency first). */
  gaps: CitationGap[];
  /** Per-competitor provenance. */
  competitors: CompetitorCrawlSummary[];
  /**
   * True when NO competitor could be crawled → no gap can be asserted at all,
   * and the report says so instead of implying the client is gap-free.
   */
  noCrawlableCompetitors: boolean;
}
