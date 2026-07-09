/**
 * M4 Competitor citation reverse-engineering — public PURE surface
 * (doc 05 §M4; doc 07 §1.4).
 *
 * The pipeline: derive competitor targets from M3's stored cited-URL inventory
 * (targets.ts) → crawl each through the SHARED M2 crawler + score with the SAME
 * frozen aeo-audit rubric (analyze.ts) → diff vs the client's own audit into a
 * prioritized, evidence-backed citation-gap list (gap-diff.ts) → shape the gaps
 * for the existing plan-generation seam (plan-input.ts).
 *
 * Server-side layers are NOT re-exported here (this barrel stays importable
 * anywhere, e.g. for types in UI code): import them by path —
 *   ./actions  — "use server" run action (runCompetitorGapAnalysis)
 *   ./persist  — server-only read API + the flagged persistence gap
 */

export type {
  CitationGap,
  CompetitorCrawlResult,
  CompetitorCrawlSummary,
  CompetitorExclusionReason,
  CompetitorGapReport,
  CompetitorSignalEvidence,
  CompetitorTarget,
  ExcludedCompetitor,
} from "./types";

export {
  competitorTargetsFromCitedUrls,
  resolveCompetitorCrawlUrl,
  type ResolvedCrawlTarget,
} from "./targets";

export {
  analyzeCompetitors,
  DEFAULT_COMPETITOR_CRAWL_BOUNDS,
  type AnalyzeCompetitorsInput,
} from "./analyze";

export {
  buildCompetitorGapReport,
  LEAD_MARGIN,
  SIGNAL_PRESENT_MIN_SCORE,
  type BuildGapReportMeta,
} from "./gap-diff";

export {
  competitorGapPlanInput,
  type CompetitorGapPlanInput,
} from "./plan-input";
