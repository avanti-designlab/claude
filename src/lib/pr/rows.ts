/**
 * M12 PR entity-leverage — pure entity-authority → `audits` row mapping (frozen
 * schema: supabase/migrations/0005_audits_content_items_site_changes.sql).
 *
 * Mirrors the M14 local split (src/lib/local/rows.ts): no server imports, no
 * Supabase client — unit-tested in the default run; the persist module feeds
 * these rows to PostgREST.
 *
 * PERSISTENCE DECISION (honest, against the FROZEN schema 0005): an entity-
 * authority report is a "rubric-style capture against the playbook for a
 * property", which is exactly what `audits` holds (`score jsonb`, `fixes jsonb`,
 * keyed by tenant+client+property). M12 crawls the website property, so
 * `property_id` = that property; the capture lands in `score`, the entity fixes
 * in `fixes`.
 *
 * ⚑ SHARED-TABLE DISCRIMINATOR + HARD WIRING PRECONDITION (identical to M14's):
 * M2's `readAuditHistory` (src/lib/intelligence/audit/persist.ts) reads EVERY
 * `audits` row for a client and folds `score.overallScore` into the AEO trend
 * line. So this capture carries `kind: "entity_authority"` and M12 reads history
 * through its OWN `readEntityAuthorityHistory` (kind-filtered). BEFORE M12
 * persistence is wired to a LIVE action, M2's reader must EXCLUDE non-audit
 * `kind` rows (the same one-line filter M14 already requires, owner:
 * M2/aeo-seo-logic-engineer) — otherwise entity-authority captures would pollute
 * the AEO audit trend. Until that live wiring exists (this task ships library +
 * tests only, commits nothing), nothing lands in a shared live `audits` table.
 */

import type { CrawlCoverage } from "@/lib/intelligence/crawl";
import type { EntityAuthorityReport, EntityFixDraft } from "./types";

/** Discriminator distinguishing an entity-authority capture from an M2/M14 capture. */
export const ENTITY_AUTHORITY_KIND = "entity_authority" as const;

/**
 * The `audits.score` jsonb for an entity-authority assessment. `overallScore` is
 * a real entity-authority roll-up over the measurable signals — but it is ALWAYS
 * accompanied by `kind` so a kind-aware reader can never mistake it for an AEO
 * audit's score. Null when the site was not assessable (never a fabricated 0).
 */
export interface EntityAuthorityScoreCapture {
  kind: typeof ENTITY_AUTHORITY_KIND;
  vertical: string;
  crawledAt: string;
  assessable: boolean;
  /** 0–100 roll-up over the measurable entity signals, or null when not assessable. */
  overallScore: number | null;
  personStatus: string;
  namePresentOnPage: boolean;
  personSchemaPresent: boolean;
  sameAsPresentInSchema: boolean;
  pressSectionPresent: boolean;
  pressCorroborated: number;
  pressClaimed: number;
  fixCount: number;
  coverage: CrawlCoverage | null;
}

/** Insert shape for `audits` (migration 0005 — only the caller-set columns). */
export interface EntityAuthorityInsertRow {
  tenant_id: string;
  client_id: string;
  property_id: string;
  score: EntityAuthorityScoreCapture;
  fixes: EntityFixDraft[];
}

/**
 * An entity-authority roll-up: the share of measurable positive entity signals
 * present (person named on-page, Person schema present, Person schema has
 * sameAs, a press surface exists, ≥1 press item corroborated). Null when the
 * site was not assessable — we never invent a score from no data.
 */
function rollUpScore(report: EntityAuthorityReport): number | null {
  if (!report.assessable) return null;
  const signals: boolean[] = [
    report.person.status === "assessed" && report.person.namePresentOnPage,
    report.person.personSchemaPresent,
    report.person.sameAsPresentInSchema,
    report.press.pressSectionPresent,
    report.press.corroboratedCount > 0,
  ];
  const score = (signals.filter(Boolean).length / signals.length) * 100;
  return Math.round(score * 10) / 10;
}

export function entityAuthorityScoreCapture(report: EntityAuthorityReport): EntityAuthorityScoreCapture {
  return {
    kind: ENTITY_AUTHORITY_KIND,
    vertical: report.vertical,
    crawledAt: report.crawledAt,
    assessable: report.assessable,
    overallScore: rollUpScore(report),
    personStatus: report.person.status,
    namePresentOnPage: report.person.namePresentOnPage,
    personSchemaPresent: report.person.personSchemaPresent,
    sameAsPresentInSchema: report.person.sameAsPresentInSchema,
    pressSectionPresent: report.press.pressSectionPresent,
    pressCorroborated: report.press.corroboratedCount,
    pressClaimed: report.press.claimedCount,
    fixCount: report.fixes.length,
    coverage: report.coverage,
  };
}

/** The `audits` row for one entity-authority assessment run. */
export function entityAuthorityInsertRow(args: {
  tenantId: string;
  clientId: string;
  propertyId: string;
  report: EntityAuthorityReport;
}): EntityAuthorityInsertRow {
  return {
    tenant_id: args.tenantId,
    client_id: args.clientId,
    property_id: args.propertyId,
    score: entityAuthorityScoreCapture(args.report),
    fixes: args.report.fixes,
  };
}

/* ------------------------------------------------------------------ */
/* History reads (defensive jsonb parsing)                             */
/* ------------------------------------------------------------------ */

/** One entity-authority history entry — the entity trend line's data point. */
export interface EntityAuthorityHistoryEntry {
  id: string;
  propertyId: string;
  createdAt: string;
  overallScore: number | null;
  pressCorroborated: number | null;
  pressClaimed: number | null;
  fixCount: number | null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** True when a raw `audits.score` jsonb is an entity-authority capture. */
export function isEntityAuthorityScore(score: unknown): boolean {
  return (
    typeof score === "object" &&
    score !== null &&
    (score as Record<string, unknown>).kind === ENTITY_AUTHORITY_KIND
  );
}

/** Shape a raw `audits` row (RLS-scoped read) into an entity-authority history entry. */
export function entityAuthorityHistoryEntry(row: {
  id: string;
  property_id: string;
  created_at: string;
  score: unknown;
}): EntityAuthorityHistoryEntry {
  const score = (typeof row.score === "object" && row.score !== null ? row.score : {}) as Record<string, unknown>;
  return {
    id: row.id,
    propertyId: row.property_id,
    createdAt: row.created_at,
    overallScore: finiteNumber(score.overallScore),
    pressCorroborated: finiteNumber(score.pressCorroborated),
    pressClaimed: finiteNumber(score.pressClaimed),
    fixCount: finiteNumber(score.fixCount),
  };
}
