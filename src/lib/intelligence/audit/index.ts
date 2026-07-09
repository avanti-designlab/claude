/**
 * M2 Audit Engine — public API (doc 05 M2, doc 07 §1.4).
 *
 * Crawl a client property (bounded, robots-respecting, same-origin) → score
 * it with the FROZEN aeo-audit skill against the client's vertical playbook
 * → an `AuditResult` whose prioritized fixes flow straight into plan
 * regeneration (`generatePlan({ playbook, now, audit })`, src/lib/plan) and
 * an immutable history row in the frozen `audits` table.
 *
 * Server actions (`runPropertyAudit`, `listAuditHistory`) live in
 * ./actions — imported directly by the app layer, deliberately not
 * re-exported here so the pure engine surface stays importable from
 * client-adjacent code without dragging in "use server" modules.
 */

export { auditProperty, type PropertyAuditInput, type PropertyAuditResult } from "./engine";
export {
  auditHistoryEntry,
  auditInsertRow,
  type AuditHistoryEntry,
  type AuditInsertRow,
  type AuditScoreCapture,
  type StoredCheckResult,
} from "./rows";
