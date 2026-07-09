/**
 * M4 → plan generation seam (doc 05 §M4; doc 02 / doc 07 §1.1) — PURE.
 *
 * M4's gaps flow into the roadmap the SAME way M2's audit fixes do — because
 * they ARE the client's own audit fixes, selected and prioritized by competitor
 * evidence. `competitorGapPlanInput` collects the distinct client fixes across
 * the gaps (dedup by id, gap-priority order preserved) into the shape the
 * EXISTING audit-merge seam consumes: `generatePlan`'s `asAuditResult` reads
 * ONLY `.fixes`, so `{ fixes }` flows through `auditTasks` unchanged and each
 * competitor-corroborated fix becomes an audit-sourced, channel-anchored
 * roadmap task carrying the skill's impact/automation truth.
 *
 * ⚑ FLAG — no dedicated "competitor" task provenance yet. The frozen roadmap
 * type (`RoadmapTask.source`, src/lib/types/roadmap) models `"playbook"` |
 * `"audit"` only; M4's corroborated fixes ride the `"audit"` source (honest —
 * they are a subset of the client's audit fixes). A distinct `"competitor"`
 * source, so the dashboard can say "your competitors already solved this",
 * would require a post-freeze change to the roadmap types (Orchestrator + Code
 * Review, CLAUDE.md rule 1) and is deferred. This module stays inside
 * competitors/**; it does not modify the plan or roadmap types.
 */

import type { AuditFix } from "@/lib/skills/aeo-audit";
import type { CompetitorGapReport } from "./types";

/**
 * The audit-merge-seam-compatible bundle. Shaped to satisfy `asAuditResult`
 * (src/lib/plan/audit-merge.ts), which narrows an unknown audit input by
 * checking `Array.isArray(fixes)` — this is exactly, and only, what the seam
 * reads. Pass it straight to `generatePlan({ playbook, now, audit })`.
 */
export interface CompetitorGapPlanInput {
  fixes: AuditFix[];
}

export function competitorGapPlanInput(report: CompetitorGapReport): CompetitorGapPlanInput {
  const seen = new Set<string>();
  const fixes: AuditFix[] = [];
  for (const gap of report.gaps) {
    for (const fix of gap.fixes) {
      if (seen.has(fix.id)) continue;
      seen.add(fix.id);
      fixes.push(fix);
    }
  }
  return { fixes };
}
