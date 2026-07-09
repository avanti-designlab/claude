/**
 * M4 gap-diff suite — the honesty core of a competitive-analysis feature.
 *
 * Pins: gaps anchor on client fixes + competitor lead; the "N of M" denominator
 * EXCLUDES uncrawlable competitors AND indeterminate (skipped) checks and never
 * counts them as absence-of-signal; n=1 is labeled; a lead needs both "present"
 * AND "meaningfully ahead"; no gap when competitors are also weak or the client
 * has no fix; the report is deterministic and priority-ordered.
 */

import { describe, expect, it } from "vitest";
import type { AuditFix, AuditResult, CheckId, CheckResult } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import { normalizeDomain } from "@/lib/intelligence/visibility";
import {
  buildCompetitorGapReport,
  LEAD_MARGIN,
  SIGNAL_PRESENT_MIN_SCORE,
} from "./gap-diff";
import type { CompetitorCrawlResult, CompetitorExclusionReason, CompetitorTarget } from "./types";

const META = {
  playbookVertical: "real-estate",
  playbookVersion: "1.0.0",
  analyzedAt: "2026-07-09T00:00:00.000Z",
};

const CHECK_NAME: Partial<Record<CheckId, string>> = {
  schema_presence_validity: "Schema presence + validity",
  faq_direct_answer: "FAQ direct-answer formatting",
  onpage_basics: "Title / meta / H1 / alt coverage",
};

function check(checkId: CheckId, score: number | null): CheckResult {
  return {
    checkId,
    name: CHECK_NAME[checkId] ?? checkId,
    status: score === null ? "skipped" : "scored",
    ...(score === null ? { skipReason: "not_applicable" as const } : {}),
    score,
    weight: score === null ? 0 : 10,
    evidence: [],
    fixes: [],
  };
}

function fix(id: string, checkId: CheckId, impact: AuditFix["impact"] = "high"): AuditFix {
  return {
    id,
    checkId,
    title: `Fix ${checkId}`,
    detail: "Concrete client-side remediation.",
    targetUrls: [],
    impact,
    impactEstimate: "meaningful citation lift",
    module: "M10",
    automationLevel: "ai_draft_human_approve",
    priorityScore: 1,
  };
}

function audit(checks: CheckResult[], fixes: AuditFix[]): AuditResult {
  return {
    overallScore: 50,
    checks,
    fixes,
    dataGaps: [],
    playbookVertical: "real-estate",
    localChecksApplied: true,
    crawledAt: META.analyzedAt,
  };
}

function coverage(crawled: number): CrawlCoverage {
  return {
    attempted: crawled,
    crawled,
    pages: [],
    robotsTxtStatus: "fetched",
    llmsTxtStatus: "absent",
    frontierTruncated: false,
    offOriginRefused: 0,
  };
}

function target(name: string | null, citedUrl: string): CompetitorTarget {
  return { citedUrl, domain: normalizeDomain(citedUrl), name, citationCount: 1, engines: [] };
}

function scored(name: string, citedUrl: string, a: AuditResult): CompetitorCrawlResult {
  return { target: target(name, citedUrl), crawlUrl: citedUrl, status: "scored", audit: a, coverage: coverage(3), exclusionReason: null };
}

function excluded(name: string, citedUrl: string, reason: CompetitorExclusionReason): CompetitorCrawlResult {
  return {
    target: target(name, citedUrl),
    crawlUrl: reason === "not_crawlable_url" ? null : citedUrl,
    status: "excluded",
    audit: null,
    coverage: reason === "not_crawlable_url" ? null : coverage(0),
    exclusionReason: reason,
  };
}

/** A competitor audit that scores `score` on schema (only). */
function competitorSchema(score: number): AuditResult {
  return audit([check("schema_presence_validity", score)], []);
}

describe("buildCompetitorGapReport — gap detection", () => {
  it("asserts a gap when the client is weak and competitors lead, with the client's own fix as 'do Y'", () => {
    const clientAudit = audit(
      [check("schema_presence_validity", 40)],
      [fix("schema_presence_validity/add-faqpage", "schema_presence_validity")],
    );
    const report = buildCompetitorGapReport(
      clientAudit,
      [
        scored("Alpha", "https://alpha.example/guide", competitorSchema(85)),
        scored("Beta", "https://beta.example/guide", competitorSchema(90)),
        scored("Gamma", "https://gamma.example/guide", competitorSchema(50)), // present-fail: not a leader
      ],
      META,
    );

    expect(report.gaps).toHaveLength(1);
    const gap = report.gaps[0];
    expect(gap.checkId).toBe("schema_presence_validity");
    expect(gap.competitorsLeading).toBe(2); // Alpha + Beta lead; Gamma does not
    expect(gap.competitorsCompared).toBe(3); // all three were scored on schema
    expect(gap.clientScore).toBe(40);
    expect(gap.fixes.map((f) => f.id)).toEqual(["schema_presence_validity/add-faqpage"]);
    expect(gap.leaders.map((l) => l.name)).toEqual(["Alpha", "Beta"]);
    expect(gap.summary).toContain("2 of 3");
    expect(gap.summary).toContain("Schema presence + validity");
    expect(gap.summary).toContain("40");
    expect(report.competitorsScored).toBe(3);
    expect(report.noCrawlableCompetitors).toBe(false);
  });

  it("a lead requires BOTH present (≥threshold) AND meaningfully ahead (≥margin)", () => {
    const clientAudit = audit(
      [check("schema_presence_validity", SIGNAL_PRESENT_MIN_SCORE)], // client at threshold, 70
      [fix("schema/x", "schema_presence_validity")],
    );
    const report = buildCompetitorGapReport(
      clientAudit,
      [
        // present (78 ≥ 70) but only +8 ahead of 70 → NOT meaningfully ahead
        scored("Close", "https://close.example", competitorSchema(SIGNAL_PRESENT_MIN_SCORE + LEAD_MARGIN - 1)),
        // +margin ahead but BELOW present threshold is impossible here (70+15=85≥70);
        // use a clearly-ahead-and-solid competitor as the positive control
        scored("Clear", "https://clear.example", competitorSchema(SIGNAL_PRESENT_MIN_SCORE + LEAD_MARGIN + 5)),
      ],
      META,
    );
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].competitorsLeading).toBe(1);
    expect(report.gaps[0].competitorsCompared).toBe(2);
    expect(report.gaps[0].leaders.map((l) => l.name)).toEqual(["Clear"]);
  });

  it("'present but low' does not lead — a competitor ahead-by-margin yet below the present threshold is not solid", () => {
    const clientAudit = audit(
      [check("schema_presence_validity", 10)],
      [fix("schema/x", "schema_presence_validity")],
    );
    // 60 is +50 ahead of 10 (≥ margin) but < present threshold (70): not "has the signal".
    const report = buildCompetitorGapReport(
      clientAudit,
      [scored("Meh", "https://meh.example", competitorSchema(60))],
      META,
    );
    expect(report.gaps).toHaveLength(0);
  });

  it("no gap when competitors are also weak (nobody won → nothing asserted)", () => {
    const clientAudit = audit(
      [check("schema_presence_validity", 40)],
      [fix("schema/x", "schema_presence_validity")],
    );
    const report = buildCompetitorGapReport(
      clientAudit,
      [
        scored("A", "https://a.example", competitorSchema(45)),
        scored("B", "https://b.example", competitorSchema(50)),
      ],
      META,
    );
    expect(report.gaps).toHaveLength(0);
    expect(report.noCrawlableCompetitors).toBe(false);
  });

  it("no gap on a check where competitors lead but the CLIENT has no fix (no fabricated 'do Y')", () => {
    // Client scores low on FAQ too, but its audit produced NO faq fix.
    const clientAudit = audit(
      [check("schema_presence_validity", 40), check("faq_direct_answer", 30)],
      [fix("schema/x", "schema_presence_validity")],
    );
    const competitor = audit(
      [check("schema_presence_validity", 90), check("faq_direct_answer", 95)],
      [],
    );
    const report = buildCompetitorGapReport(clientAudit, [scored("A", "https://a.example", competitor)], META);
    expect(report.gaps.map((g) => g.checkId)).toEqual(["schema_presence_validity"]);
  });
});

describe("buildCompetitorGapReport — denominator honesty", () => {
  const clientAudit = audit(
    [check("schema_presence_validity", 40)],
    [fix("schema/x", "schema_presence_validity")],
  );

  it("EXCLUDES uncrawlable competitors from M and reports them with reasons (never absence-of-signal)", () => {
    const report = buildCompetitorGapReport(
      clientAudit,
      [
        scored("Alpha", "https://alpha.example", competitorSchema(90)),
        excluded("Blocked", "http://169.254.169.254/", "blocked_address"),
        excluded("Robots", "https://robots.example", "robots_blocked"),
        excluded("Dead", "https://dead.example", "unreachable"),
        excluded("Junk", "not-a-url", "not_crawlable_url"),
      ],
      META,
    );
    expect(report.gaps).toHaveLength(1);
    // M counts ONLY the one scored competitor — the four excluded never enter it.
    expect(report.gaps[0].competitorsCompared).toBe(1);
    expect(report.gaps[0].competitorsLeading).toBe(1);
    expect(report.competitorsScored).toBe(1);
    expect(report.excluded).toEqual([
      { name: "Blocked", citedUrl: "http://169.254.169.254/", reason: "blocked_address" },
      { name: "Robots", citedUrl: "https://robots.example", reason: "robots_blocked" },
      { name: "Dead", citedUrl: "https://dead.example", reason: "unreachable" },
      { name: "Junk", citedUrl: "not-a-url", reason: "not_crawlable_url" },
    ]);
  });

  it("EXCLUDES indeterminate (skipped) competitor checks from M — a skip is not an absence", () => {
    const report = buildCompetitorGapReport(
      clientAudit,
      [
        scored("Alpha", "https://alpha.example", competitorSchema(90)), // scored → in M
        scored("Skipper", "https://skip.example", audit([check("schema_presence_validity", null)], [])), // skipped → NOT in M
      ],
      META,
    );
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0].competitorsCompared).toBe(1); // Skipper's skipped check is not counted
    expect(report.gaps[0].competitorsLeading).toBe(1);
    expect(report.competitorsScored).toBe(2); // both were crawled+scored overall
  });

  it("labels n=1 explicitly when only one crawlable competitor could be compared", () => {
    const report = buildCompetitorGapReport(
      clientAudit,
      [scored("Solo", "https://solo.example", competitorSchema(88))],
      META,
    );
    expect(report.gaps[0].competitorsCompared).toBe(1);
    expect(report.gaps[0].summary).toContain("1 of 1");
    expect(report.gaps[0].summary).toContain("n=1");
  });

  it("no crawlable competitors → no gaps asserted, and the report says so", () => {
    const report = buildCompetitorGapReport(
      clientAudit,
      [
        excluded("A", "http://127.0.0.1/", "blocked_address"),
        excluded("B", "https://b.example", "unreachable"),
      ],
      META,
    );
    expect(report.gaps).toHaveLength(0);
    expect(report.competitorsScored).toBe(0);
    expect(report.noCrawlableCompetitors).toBe(true);
    expect(report.excluded).toHaveLength(2);
  });
});

describe("buildCompetitorGapReport — determinism + ordering", () => {
  it("orders gaps by lead-consistency (N/M) desc and is byte-identical across runs", () => {
    // schema: 1 of 2 lead (ratio .5); faq: 2 of 2 lead (ratio 1) → faq first.
    const clientAudit = audit(
      [check("schema_presence_validity", 40), check("faq_direct_answer", 40)],
      [fix("schema/x", "schema_presence_validity"), fix("faq/y", "faq_direct_answer")],
    );
    const compA = audit([check("schema_presence_validity", 90), check("faq_direct_answer", 90)], []);
    const compB = audit([check("schema_presence_validity", 50), check("faq_direct_answer", 92)], []);
    const results = [scored("A", "https://a.example", compA), scored("B", "https://b.example", compB)];

    const a = buildCompetitorGapReport(clientAudit, results, META);
    const b = buildCompetitorGapReport(clientAudit, results, META);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    expect(a.gaps.map((g) => g.checkId)).toEqual(["faq_direct_answer", "schema_presence_validity"]);
    expect(a.gaps[0].competitorsLeading).toBe(2);
    expect(a.gaps[0].competitorsCompared).toBe(2);
    expect(a.gaps[1].competitorsLeading).toBe(1);
    expect(a.gaps[1].competitorsCompared).toBe(2);
  });
});
