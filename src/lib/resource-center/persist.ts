import "server-only";

/**
 * M18 Resource Center — persistence decision (honest, against the FROZEN schema,
 * migrations 0001–0008). Mirrors src/lib/intelligence/competitors/persist.ts.
 *
 * PERSISTENCE DECISION: there is NO table in the frozen F1 schema that holds a
 * resource-center Q&A exchange or a research brief.
 *   - No `resource_qa` / `research` / `questions` table exists (migrations
 *     0001–0008).
 *   - `content_items` is the PRODUCTION pipeline's store (type CHECK =
 *     blog|faq|caption|pillar|schema_copy, migration 0005) — a Q&A exchange is a
 *     research aid, not a produced content draft; forcing it under a wrong type
 *     is exactly the dishonest persist M8 refuses.
 *   - `metrics.source` CHECK admits only gsc/ga4/call_tracking/local_rank/
 *     reviews (migration 0006) — not a resource-center signal.
 *   - `alerts` is M17's notification surface, not an analysis/Q&A store.
 *
 * So M18 follows the M3/M4 precedent for what the frozen schema can't hold:
 * RETURN-WITHOUT-INVENTING and FLAG THE GAP. The graded answer + the M3/M8 feed
 * shapes are returned live by the action; nothing is written. The proposed
 * frozen-schema addition is a tenant-scoped, RLS'd `resource_qa` table (immutable
 * captures like `audits`, storing the question + graded answer + attributed
 * source URLs — NO raw vendor payload, NO PII), deferred to the post-freeze
 * Orchestrator + Code Review path (CLAUDE.md rule 1).
 *
 * Deliberately NOT a real write path: `persistResourceAnswer` takes no Supabase
 * client and no tenant, so it can never be mistaken for one and can never leak a
 * question into a table. Isolation of the (future) row is RLS's job when the
 * table lands; until then there is nothing to isolate because nothing is stored.
 */

/**
 * The greppable schema-gap flag surfaced everywhere M18 would otherwise persist
 * (Orchestrator/documentation agent — M3/M4/M8/M15 precedent).
 */
export const RESOURCE_CENTER_PERSISTENCE_GAP =
  "No frozen-schema table holds a resource-center Q&A exchange or research brief (migrations " +
  "0001–0008: no resource_qa table; content_items.type CHECK doesn't admit a research aid; " +
  "metrics.source and alerts.type CHECKs don't admit it). The graded answer + the M3/M8 feed " +
  "shapes are returned live and NOT persisted. Proposed addition: a tenant-scoped, RLS'd " +
  "resource_qa table (question + graded answer + attributed source URLs, no PII/vendor payload) — " +
  "deferred to the post-freeze Orchestrator + Code Review path.";

/**
 * The persistence outcome. There is exactly one variant today: NOT persisted,
 * with the flag. Writing an inventing row into content_items/metrics/alerts
 * would corrupt another module's data — so this writes nothing.
 */
export type PersistResourceAnswerOutcome = {
  kind: "not_persisted";
  reason: "no_table";
  flag: string;
};

/**
 * "Persist" a resource-center answer — honestly a no-op against the frozen
 * schema. Returns the flagged gap; the caller keeps the live answer + feeds.
 */
export function persistResourceAnswer(): PersistResourceAnswerOutcome {
  return { kind: "not_persisted", reason: "no_table", flag: RESOURCE_CENTER_PERSISTENCE_GAP };
}
