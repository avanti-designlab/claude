/**
 * M4 gap-diff (doc 05 §M4) — PURE, deterministic.
 *
 * Diffs the client's own audit against the scored cited competitors and emits a
 * prioritized "citation gap" list: rubric checks on which the client has an
 * actionable fix AND at least one crawlable cited competitor demonstrably LEADS
 * the client. Each gap carries the client's own audit fix(es) as the concrete
 * "do Y", and an evidence-backed "N of M competitors" claim.
 *
 * WHY ANCHOR ON THE CLIENT'S FIXES. M4's deliverable is the specific
 * gap-closing TASK ("they win because X; do Y"). The client's audit already
 * emitted skill-authored, prioritized fixes (the honest "do Y"); M4 uses the
 * competitor crawl to PRIORITIZE which of those fixes competitors have already
 * solved — the highest-value signal in the category. A check where competitors
 * lead but the client's audit produced no fix is out of scope for a task (a
 * fabricated remediation would violate the honesty rule); it is not asserted.
 *
 * ── DENOMINATOR HONESTY (the spine of a competitive-analysis feature) ────────
 *  - Only SCORED competitors reach this function — an uncrawlable competitor
 *    (SSRF-blocked / robots-blocked / unreachable / not a web target) carried
 *    ZERO rubric signal and is already excluded upstream (analyze.ts) and
 *    reported in `excluded`. It is NEVER in any denominator.
 *  - Per check, a scored competitor counts toward M only when the check was
 *    SCORED for it (and for the client) — a check SKIPPED on a competitor
 *    (not-applicable / no-data / local-off) is indeterminate, not "absent", so
 *    it is excluded from M too.
 *  - M is therefore "competitors we could actually compare on this check";
 *    N ("competitors that lead") ≤ M. A gap from M === 1 says n=1 explicitly.
 *
 * ── THRESHOLDS (⚑ doc-silent — flagged for ratification) ─────────────────────
 * A competitor LEADS the client on a check when it is genuinely solid AND
 * genuinely ahead — not merely "less bad":
 *   competitorScore ≥ SIGNAL_PRESENT_MIN_SCORE   (demonstrably HAS the signal)
 *   AND competitorScore − clientScore ≥ LEAD_MARGIN   (meaningfully ahead)
 * Both are 1.4 engineering choices, defensible and documented, not doctrine —
 * ratify alongside the aeo-audit base weights / crawl bounds (BUILD-STATE ⚑).
 */

import type { AuditFix, AuditResult, CheckId, CheckResult } from "@/lib/skills/aeo-audit";
import type {
  CitationGap,
  CompetitorCrawlResult,
  CompetitorCrawlSummary,
  CompetitorSignalEvidence,
  CompetitorGapReport,
  ExcludedCompetitor,
} from "./types";

/** A competitor scoring ≥ this on a check demonstrably HAS that signal. ⚑ */
export const SIGNAL_PRESENT_MIN_SCORE = 70;

/** A competitor must be at least this many points ahead to "lead". ⚑ */
export const LEAD_MARGIN = 15;

/** Impact rank for deterministic tie-breaking (higher = more severe). */
const IMPACT_RANK: Record<AuditFix["impact"], number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

/** The scored CheckResult for a check id, or undefined when absent/skipped. */
function scoredCheck(audit: AuditResult, checkId: CheckId): CheckResult | undefined {
  const check = audit.checks.find((c) => c.checkId === checkId);
  if (!check || check.status !== "scored" || check.score === null) return undefined;
  return check;
}

/** Distinct check ids the client has an actionable fix for, in fix order. */
function clientFixCheckIds(clientAudit: AuditResult): CheckId[] {
  const seen = new Set<CheckId>();
  const ids: CheckId[] = [];
  for (const fix of clientAudit.fixes) {
    if (seen.has(fix.checkId)) continue;
    seen.add(fix.checkId);
    ids.push(fix.checkId);
  }
  return ids;
}

/** Honest, evidence-backed one-liner for a gap. n=1 is stated explicitly. */
function gapSummary(
  checkName: string,
  leading: number,
  compared: number,
  clientScore: number
): string {
  const noun = compared === 1 ? "crawlable cited competitor" : "crawlable cited competitors";
  const verb = leading === 1 ? "leads" : "lead";
  const base = `${leading} of ${compared} ${noun} ${verb} you on ${checkName} (they score ≥${SIGNAL_PRESENT_MIN_SCORE}, at least ${LEAD_MARGIN} points ahead of your ${clientScore}); do the client fix(es) below.`;
  return compared === 1 ? `${base} n=1 — low confidence, one competitor only.` : base;
}

export interface BuildGapReportMeta {
  playbookVertical: string;
  playbookVersion: string;
  analyzedAt: string;
}

/**
 * Build the prioritized citation-gap report. `competitorResults` is the FULL
 * per-competitor outcome list (scored + excluded) from analyze.ts — excluded
 * ones drive the honest `excluded` list and NEVER a denominator.
 */
export function buildCompetitorGapReport(
  clientAudit: AuditResult,
  competitorResults: CompetitorCrawlResult[],
  meta: BuildGapReportMeta
): CompetitorGapReport {
  const scored = competitorResults.filter((r) => r.status === "scored" && r.audit !== null);
  const excluded: ExcludedCompetitor[] = competitorResults
    .filter((r) => r.status === "excluded")
    .map((r) => ({
      name: r.target.name,
      citedUrl: r.target.citedUrl,
      reason: r.exclusionReason ?? "unreachable",
    }));

  const gaps: CitationGap[] = [];
  for (const checkId of clientFixCheckIds(clientAudit)) {
    const clientCheck = scoredCheck(clientAudit, checkId);
    // A fix on a check the client's audit did not score is not comparable —
    // skip defensively (checks emit fixes only when scored, so this is a guard).
    if (clientCheck === undefined) continue;
    const clientScore = clientCheck.score as number;

    const compared: CompetitorSignalEvidence[] = [];
    const leaders: CompetitorSignalEvidence[] = [];
    for (const result of scored) {
      const competitorCheck = scoredCheck(result.audit as AuditResult, checkId);
      if (competitorCheck === undefined) continue; // indeterminate → not in M
      const score = competitorCheck.score as number;
      const evidence: CompetitorSignalEvidence = {
        name: result.target.name,
        citedUrl: result.target.citedUrl,
        score,
      };
      compared.push(evidence);
      if (score >= SIGNAL_PRESENT_MIN_SCORE && score - clientScore >= LEAD_MARGIN) {
        leaders.push(evidence);
      }
    }

    if (leaders.length === 0) continue; // no competitor leads → not a citation gap

    gaps.push({
      checkId,
      checkName: clientCheck.name,
      competitorsLeading: leaders.length,
      competitorsCompared: compared.length,
      clientScore,
      leaders,
      compared,
      fixes: clientAudit.fixes.filter((fix) => fix.checkId === checkId),
      summary: gapSummary(clientCheck.name, leaders.length, compared.length, clientScore),
    });
  }

  gaps.sort(gapComparator);

  const competitors: CompetitorCrawlSummary[] = competitorResults.map((r) => ({
    name: r.target.name,
    citedUrl: r.target.citedUrl,
    crawlUrl: r.crawlUrl,
    status: r.status,
    overallScore: r.audit ? r.audit.overallScore : null,
    pagesCrawled: r.coverage ? r.coverage.crawled : null,
    exclusionReason: r.exclusionReason,
  }));

  return {
    playbookVertical: meta.playbookVertical,
    playbookVersion: meta.playbookVersion,
    analyzedAt: meta.analyzedAt,
    competitorsScored: scored.length,
    excluded,
    gaps,
    competitors,
    noCrawlableCompetitors: scored.length === 0,
  };
}

/** Highest severity of a gap's client fixes — a fully deterministic tiebreak. */
function maxFixImpactRank(gap: CitationGap): number {
  return gap.fixes.reduce((max, fix) => Math.max(max, IMPACT_RANK[fix.impact]), 0);
}

/**
 * Deterministic gap ordering. "Consistently have" first: the share of compared
 * competitors that lead (N/M), then the raw count that lead, then the strongest
 * client-fix severity, then check id — a total order, so identical inputs give
 * a byte-identical report.
 */
function gapComparator(a: CitationGap, b: CitationGap): number {
  const aRatio = a.competitorsLeading / a.competitorsCompared;
  const bRatio = b.competitorsLeading / b.competitorsCompared;
  return (
    bRatio - aRatio ||
    b.competitorsLeading - a.competitorsLeading ||
    maxFixImpactRank(b) - maxFixImpactRank(a) ||
    (a.checkId < b.checkId ? -1 : a.checkId > b.checkId ? 1 : 0)
  );
}
