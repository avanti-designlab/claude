/**
 * M12 → plan generation seam (doc 05 M12; doc 02 / doc 07 §1.1) — PURE.
 *
 * M12's entity-authority fixes flow into the roadmap the SAME way M2's audit
 * fixes do — `generatePlan`'s `asAuditResult` (src/lib/plan/audit-merge.ts)
 * narrows on `Array.isArray(fixes)` and `auditTasks` reads ONLY each fix's
 * id/checkId/title/detail/impact/impactEstimate/module/automationLevel, so
 * `{ fixes }` flows through `auditTasks` unchanged: each entity fix becomes an
 * audit-sourced, channel-anchored roadmap task carrying the fix's impact +
 * automation truth. Mirrors M6's `decayPlanInput`, M4's competitor projection,
 * and M14's `localPlanInput` — M12 invents no plan logic.
 *
 * WHY `module: "M12"` RIDES THROUGH (the load-bearing detail): the aeo-audit
 * skill's `OwningModule` enum (frozen, out of bounds) does NOT include "M12", but
 * "M12" IS a valid roadmap `ModuleRef`, and audit-merge already models it —
 * `roadmapModuleForFix` passes a non-M13 module straight through, and
 * `MODULE_CHANNEL_ARCHETYPES.M12 = ["entity","offsite","podcast"]` homes an M12
 * fix to the playbook's entity channel. This projection is typed as `{ fixes:
 * EntityFixDraft[] }` and handed to `generatePlan({ audit })` whose `audit` is
 * `unknown`, so the pinned-"M12" literal never crosses a type boundary it would
 * violate; at runtime auditTasks reads exactly the fields present. (M14 proved
 * this `{ fixes }`-as-`unknown` path against the same seam.)
 *
 * ⚑ PLAN-INTEGRATION FLAG (for the plan-integration owner; same class as the
 * M6↔M2 freshness + M14↔M2 local flags): M2's audit ALSO emits
 * `entity_consistency` fixes when its rubric scores entity signals. Feeding BOTH
 * a full `AuditResult` and this M12 projection into one `generatePlan` call could
 * double-list entity work. The seam must pick one entity source per regeneration
 * (recommended: the full audit when a crawl audit is in the loop; this projection
 * on the PR/entity cadence), or dedup by fix id — never merge both blindly.
 */

import type { EntityFixDraft } from "./types";
import type { EntityAuthorityReport } from "./types";

/** The distinct entity fixes a report carries (dedup by id, order preserved). */
export function entityFixes(report: EntityAuthorityReport): EntityFixDraft[] {
  const seen = new Set<string>();
  const fixes: EntityFixDraft[] = [];
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
 * fabricating scores or checks M12 never computed. Pass straight to
 * `generatePlan({ playbook, now, audit: entityPlanInput(report) })`.
 */
export function entityPlanInput(report: EntityAuthorityReport): { fixes: EntityFixDraft[] } {
  return { fixes: entityFixes(report) };
}
