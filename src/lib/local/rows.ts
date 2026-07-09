/**
 * M14 Local SEO — pure local-assessment → `audits` row mapping (frozen schema:
 * supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Mirrors the M2 audit split (src/lib/intelligence/audit/rows.ts): no server
 * imports, no Supabase client — unit-tested in the default run; the persist
 * module feeds these rows to PostgREST.
 *
 * PERSISTENCE DECISION (honest, against the FROZEN schema 0005): a local report
 * is a "rubric capture against the playbook", which is exactly what `audits`
 * holds (`score jsonb`, `fixes jsonb`, keyed by tenant+client+property). M14
 * crawls the website property, so `property_id` = that property; the capture
 * lands in `score`, the local fixes in `fixes`.
 *
 * ⚑ SHARED-TABLE DISCRIMINATOR + HARD WIRING PRECONDITION: M2's
 * `readAuditHistory` (src/lib/intelligence/audit/persist.ts) reads EVERY `audits`
 * row for a client and folds `score.overallScore` into the AEO trend line. So
 * this capture carries `kind: "local_assessment"` and M14 reads history through
 * its OWN `readLocalHistory` (kind-filtered). BEFORE M14 persistence is wired to
 * a LIVE action, M2's reader must EXCLUDE `kind: "local_assessment"` rows
 * (a one-line filter, owner: M2/aeo-seo-logic-engineer) — otherwise local
 * completeness scores would pollute the AEO audit trend. Until that live wiring
 * exists (this task ships library + tests only, commits nothing), nothing lands
 * in a shared live `audits` table, so M2 is not affected.
 */

import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { FixDraft } from "@/lib/skills/aeo-audit";
import type { LocationAssessment, LocalReport } from "./types";

/** Discriminator distinguishing a local capture from an M2 audit in `audits.score`. */
export const LOCAL_ASSESSMENT_KIND = "local_assessment" as const;

/**
 * The `audits.score` jsonb for a local assessment. `overallScore` is a real
 * completeness roll-up over the locations that were assessable — but it is
 * ALWAYS accompanied by `kind` so it can never be mistaken for an AEO audit's
 * score by a kind-aware reader.
 */
export interface LocalScoreCapture {
  kind: typeof LOCAL_ASSESSMENT_KIND;
  vertical: string;
  intensity: string;
  crawledAt: string;
  /** Locations assessed (status === "assessed"); 0 is honest, not a failure. */
  assessedLocations: number;
  totalLocations: number;
  /** Mean local-readiness score over assessable locations, or null when none were. */
  overallScore: number | null;
  fixCount: number;
  locations: LocationAssessment[];
  /** Per-page crawl honesty — stored WITH the capture it qualifies. */
  coverage: CrawlCoverage | null;
}

/** Insert shape for `audits` (migration 0005 — only the caller-set columns). */
export interface LocalAssessmentInsertRow {
  tenant_id: string;
  client_id: string;
  property_id: string;
  score: LocalScoreCapture;
  fixes: FixDraft[];
}

/**
 * A local completeness roll-up over assessable locations: the mean of each
 * location's positive-signal share (nap consistent, schema ready, gbp complete).
 * Null when no location was assessable — we never invent a score from no data.
 */
function rollUpScore(report: LocalReport): number | null {
  const assessed = report.locations.filter((l) => l.status === "assessed");
  if (assessed.length === 0) return null;
  let sum = 0;
  for (const loc of assessed) {
    const signals = [
      loc.nap.assessable && loc.nap.consistent,
      loc.schemaReady,
      loc.gbp.status === "connected" && loc.gbp.completenessScore !== null && loc.gbp.completenessScore >= 70,
    ];
    sum += (signals.filter(Boolean).length / signals.length) * 100;
  }
  return Math.round((sum / assessed.length) * 10) / 10;
}

export function localScoreCapture(report: LocalReport): LocalScoreCapture {
  return {
    kind: LOCAL_ASSESSMENT_KIND,
    vertical: report.vertical,
    intensity: report.intensity,
    crawledAt: report.crawledAt,
    assessedLocations: report.locations.filter((l) => l.status === "assessed").length,
    totalLocations: report.locations.length,
    overallScore: rollUpScore(report),
    fixCount: report.fixes.length,
    locations: report.locations,
    coverage: report.coverage,
  };
}

/** The `audits` row for one local assessment run. */
export function localAssessmentInsertRow(args: {
  tenantId: string;
  clientId: string;
  propertyId: string;
  report: LocalReport;
}): LocalAssessmentInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    property_id: args.propertyId,
    score: localScoreCapture(args.report),
    fixes: args.report.fixes,
  };
}

/* ------------------------------------------------------------------ */
/* History reads (defensive jsonb parsing)                             */
/* ------------------------------------------------------------------ */

/** One local-history entry — the local trend line's data point. */
export interface LocalHistoryEntry {
  id: string;
  propertyId: string;
  createdAt: string;
  overallScore: number | null;
  assessedLocations: number | null;
  totalLocations: number | null;
  fixCount: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True when a raw `audits.score` jsonb is a local-assessment capture. */
export function isLocalScore(score: unknown): boolean {
  return (
    typeof score === "object" &&
    score !== null &&
    (score as Record<string, unknown>).kind === LOCAL_ASSESSMENT_KIND
  );
}

/** Shape a raw `audits` row (RLS-scoped read) into a local-history entry. */
export function localHistoryEntry(row: {
  id: string;
  property_id: string;
  created_at: string;
  score: unknown;
}): LocalHistoryEntry {
  const score = (typeof row.score === "object" && row.score !== null ? row.score : {}) as Record<string, unknown>;
  return {
    id: row.id,
    propertyId: row.property_id,
    createdAt: row.created_at,
    overallScore: finiteNumber(score.overallScore),
    assessedLocations: finiteNumber(score.assessedLocations),
    totalLocations: finiteNumber(score.totalLocations),
    fixCount: finiteNumber(score.fixCount),
  };
}
