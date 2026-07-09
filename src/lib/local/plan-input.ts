/**
 * M14 → plan generation seam (doc 05 M14; doc 02 / doc 07 §1.1) — PURE.
 *
 * M14's local fixes flow into the roadmap the SAME way M2's audit fixes do —
 * `generatePlan`'s `asAuditResult` (src/lib/plan/audit-merge.ts) reads ONLY
 * `.fixes`, so `{ fixes }` flows through `auditTasks` unchanged: each local fix
 * becomes an audit-sourced, channel-anchored roadmap task carrying the fix's
 * impact + automation truth. The audit-merge seam already DROPS M14/M15 fixes
 * when the local module is OFF, which lines up exactly — M14 only runs (and
 * only emits fixes) when the intensity is not OFF.
 *
 * This mirrors M6's `decayPlanInput` and M4's `competitorGapPlanInput`; M14
 * invents no plan logic and touches neither the plan nor roadmap types.
 *
 * ⚑ PLAN-INTEGRATION FLAG (for the plan-integration owner; same class as the
 * M6↔M2 freshness flag): M2's audit ALSO emits `nap_consistency` +
 * `gbp_completeness` fixes (module M14) when directory/GBP connector data is
 * threaded into its CrawledSite, and M14 emits its own on-site NAP / GBP /
 * local-schema / local-pack fixes. Feeding BOTH a full `AuditResult` and this
 * local projection into one `generatePlan` call would double-list the local
 * work. The seam must pick one local source per regeneration (recommended: the
 * full audit when a crawl+connector audit is in the loop; this projection on
 * the local-only cadence), or dedup by fix id / URL — never merge both blindly.
 */

import type { FixDraft } from "@/lib/skills/aeo-audit";
import type { LocalReport } from "./types";

/** The distinct local fixes a report carries (dedup by id, order preserved). */
export function localFixes(report: LocalReport): FixDraft[] {
  const seen = new Set<string>();
  const fixes: FixDraft[] = [];
  for (const fix of report.fixes) {
    if (seen.has(fix.id)) continue;
    seen.add(fix.id);
    fixes.push(fix);
  }
  return fixes;
}

/**
 * The `audit`-shaped input `generatePlan` consumes. `asAuditResult` (plan side)
 * only requires a `fixes` array, so this minimal object merges cleanly without
 * fabricating scores or checks the local module never computed. Pass straight
 * to `generatePlan({ playbook, now, audit: localPlanInput(report) })`.
 */
export function localPlanInput(report: LocalReport): { fixes: FixDraft[] } {
  return { fixes: localFixes(report) };
}
