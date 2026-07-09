/**
 * Pure audit-result → `audits` row mapping (frozen schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql). Mirrors
 * the plans split (src/lib/plans/rows.ts): no server imports, no Supabase
 * client — unit-tested in the default `npm test` run; the server action feeds
 * these rows to PostgREST.
 *
 * Column mapping (per 0005's comments):
 *  - `score` — "Rubric results from the aeo-audit skill": the AuditResult's
 *    scored checks + roll-up, PLUS the crawl-coverage honesty record and the
 *    playbook version that produced the run. Per-check fixes are stored as
 *    ids only — the full fix objects live once, in `fixes` (single source of
 *    truth; a drifted duplicate copy is exactly what rows.ts's payload rule
 *    exists to prevent).
 *  - `fixes` — "Prioritized fix list with impact estimates": the skill's
 *    `AuditResult.fixes` VERBATIM. No re-scoring, no invented numbers.
 *
 * Scoping ids (tenant_id / client_id / property_id) are pinned HERE from
 * caller-supplied values that are claim-/RLS-sourced upstream — and re-pinned
 * below us by RLS (`audits_insert`, migration 0005) plus the composite FK
 * (tenant, client, property) so a row can never land outside the caller's
 * tenant or reference another client's property.
 */

import type { AuditFix, CheckResult, EvidenceItem, SkipReason } from "@/lib/skills/aeo-audit";
import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { PropertyAuditResult } from "./engine";

/** A stored check: CheckResult with fixes reduced to their ids (see header). */
export interface StoredCheckResult {
  checkId: string;
  name: string;
  status: "scored" | "skipped";
  skipReason?: SkipReason;
  score: number | null;
  weight: number;
  evidence: EvidenceItem[];
  fixIds: string[];
}

/** `audits.score` jsonb — the rubric capture one history row preserves. */
export interface AuditScoreCapture {
  overallScore: number;
  playbookVertical: string;
  /** Which playbook version produced this run (trend lines must know). */
  playbookVersion: string;
  crawledAt: string;
  localChecksApplied: boolean;
  dataGaps: string[];
  /** Denormalized for lean history reads (fixes column not selected there). */
  fixCount: number;
  checks: StoredCheckResult[];
  /** Per-page crawl honesty — stored WITH the score it qualifies. */
  coverage: CrawlCoverage;
}

/** Insert shape for `audits` (migration 0005 — only the caller-set columns). */
export interface AuditInsertRow {
  tenant_id: string;
  client_id: string;
  property_id: string;
  score: AuditScoreCapture;
  fixes: AuditFix[];
}

function storedCheck(check: CheckResult): StoredCheckResult {
  return {
    checkId: check.checkId,
    name: check.name,
    status: check.status,
    ...(check.skipReason !== undefined ? { skipReason: check.skipReason } : {}),
    score: check.score,
    weight: check.weight,
    evidence: check.evidence,
    fixIds: check.fixes.map((fix) => fix.id),
  };
}

/** The `audits` row for one engine run. */
export function auditInsertRow(args: {
  tenantId: string;
  clientId: string;
  propertyId: string;
  /** The loaded playbook's version — recorded so history rows are comparable. */
  playbookVersion: string;
  result: PropertyAuditResult;
}): AuditInsertRow {
  const { audit, coverage } = args.result;
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    property_id: args.propertyId,
    score: {
      overallScore: audit.overallScore,
      playbookVertical: audit.playbookVertical,
      playbookVersion: args.playbookVersion,
      crawledAt: audit.crawledAt,
      localChecksApplied: audit.localChecksApplied,
      dataGaps: audit.dataGaps,
      fixCount: audit.fixes.length,
      checks: audit.checks.map(storedCheck),
      coverage,
    },
    fixes: audit.fixes,
  };
}

/* ------------------------------------------------------------------ */
/* History reads (defensive jsonb parsing)                             */
/* ------------------------------------------------------------------ */

/**
 * One audit-history entry — the trend line's data point. Numeric fields are
 * null (never NaN, never invented) when the stored capture doesn't carry
 * them in the expected shape: history must report what was stored, not guess.
 */
export interface AuditHistoryEntry {
  id: string;
  propertyId: string;
  createdAt: string;
  overallScore: number | null;
  fixCount: number | null;
  pagesCrawled: number | null;
  pagesFailed: number | null;
  playbookVersion: string | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Shape a raw `audits` row (RLS-scoped read) into a history entry. */
export function auditHistoryEntry(row: {
  id: string;
  property_id: string;
  created_at: string;
  score: unknown;
}): AuditHistoryEntry {
  const score = (typeof row.score === "object" && row.score !== null ? row.score : {}) as Record<string, unknown>;
  const coverage = (
    typeof score.coverage === "object" && score.coverage !== null ? score.coverage : {}
  ) as Record<string, unknown>;
  const attempted = finiteNumber(coverage.attempted);
  const crawled = finiteNumber(coverage.crawled);
  return {
    id: row.id,
    propertyId: row.property_id,
    createdAt: row.created_at,
    overallScore: finiteNumber(score.overallScore),
    fixCount: finiteNumber(score.fixCount),
    pagesCrawled: crawled,
    pagesFailed: attempted !== null && crawled !== null ? Math.max(attempted - crawled, 0) : null,
    playbookVersion: nonEmptyString(score.playbookVersion),
  };
}
