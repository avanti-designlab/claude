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

import type { AuditFix, CheckResult, EvidenceItem, ImpactLevel, SkipReason } from "@/lib/skills/aeo-audit";
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

/* ------------------------------------------------------------------ */
/* Fix-list read parsing (defensive jsonb) — thin P1 addition          */
/* ------------------------------------------------------------------ */

/**
 * One prioritized fix as the UI renders it — a defensively-parsed projection of
 * the stored `AuditFix` (the `audits.fixes` jsonb). ONLY the interface-voice,
 * human-facing fields survive: the engine's `title` / `detail` / `impactEstimate`
 * copy, its real `impact` scale, and the `targetUrls`. The engine's internal
 * bookkeeping — the `id`'s check-code prefix, `checkId`, `module` (M-codes),
 * `priorityScore`, `automationLevel` — is DROPPED and never rendered (house
 * rule: no internal codes on operator surfaces). The stored array is already
 * priority-ordered (AuditResult.fixes: highest first) and persisted verbatim, so
 * callers PRESERVE array order and never re-derive priority.
 */
export interface AuditFixView {
  /** Stable id — used ONLY as a render key, never displayed. */
  id: string;
  /** Actionable headline (the engine's copy). Present by construction — a fix
   *  with no title is dropped (it can't state what's wrong). */
  title: string;
  /** Fuller explanation (why + execution rules; the engine's copy), or null. */
  detail: string | null;
  /** The engine's real impact level, or null when the stored value is unrecognized. */
  impact: ImpactLevel | null;
  /** Human-readable impact estimate (the engine's copy), or null. */
  impactEstimate: string | null;
  /** Pages/URLs the fix targets (deduped, non-empty); may be empty. */
  targetUrls: string[];
}

const IMPACT_LEVELS = new Set<ImpactLevel>(["critical", "high", "medium", "low"]);

function impactLevel(value: unknown): ImpactLevel | null {
  return typeof value === "string" && IMPACT_LEVELS.has(value as ImpactLevel)
    ? (value as ImpactLevel)
    : null;
}

/**
 * Parse the stored `audits.fixes` jsonb into render-ready views. Returns the RAW
 * stored count alongside the parsed list so a caller can be honest when defensive
 * parsing dropped a malformed entry (rendered < rawCount → "showing X of Y").
 * A non-array (hostile / absent) value yields an empty result — never a throw,
 * never an invented fix.
 */
export function parseStoredFixes(value: unknown): {
  rawCount: number;
  fixes: AuditFixView[];
} {
  if (!Array.isArray(value)) return { rawCount: 0, fixes: [] };
  const fixes: AuditFixView[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const raw = value[i];
    if (typeof raw !== "object" || raw === null) continue;
    const fix = raw as Record<string, unknown>;
    const title = nonEmptyString(fix.title);
    // No plain-language title ⇒ can't state "what's wrong". Drop it (still
    // counted in rawCount, so the delta surfaces honestly) — never a blank row.
    if (title === null) continue;
    const targetUrls = Array.isArray(fix.targetUrls)
      ? [
          ...new Set(
            fix.targetUrls.filter(
              (u): u is string => typeof u === "string" && u.trim() !== ""
            )
          ),
        ]
      : [];
    fixes.push({
      id: nonEmptyString(fix.id) ?? `fix-${i}`,
      title,
      detail: nonEmptyString(fix.detail),
      impact: impactLevel(fix.impact),
      impactEstimate: nonEmptyString(fix.impactEstimate),
      targetUrls,
    });
  }
  return { rawCount: value.length, fixes };
}
