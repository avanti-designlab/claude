/**
 * Audit → roadmap merge (M1 + M2 seam, doc 02 / doc 05).
 *
 * When an `aeo-audit` AuditResult is supplied, each prioritized AuditFix becomes
 * a gap-closing RoadmapTask carrying the fix's impact, owning module, and
 * automation level. The fix's owning module (aeo-audit `OwningModule`) is mapped
 * onto the roadmap `ModuleRef` — the only translation needed is M13 (on-page
 * auto-fix engine), which the roadmap does not model as a work-stream; it is
 * re-homed to the roadmap module that owns that class of work.
 */

import type { AuditFix, AuditResult, CheckId } from "@/lib/skills/aeo-audit";
import type { Playbook } from "@/lib/types/playbook";
import type { ImpactLevel, ModuleRef, RoadmapTask } from "@/lib/types/roadmap";
import { IMPACT_FACTOR, effortForImpact } from "./scoring";
import {
  topChannel,
  topChannelOfArchetype,
  type ChannelArchetype,
  type WeightedChannel,
} from "./archetypes";

/** aeo-audit fixes are ai-draft-published by the auto-fix engine — boost vs. generic starters. */
const AUDIT_SOURCE_MULTIPLIER = 1.25;

/** Narrow an unknown `audit` input to an AuditResult with a prioritized fix list. */
export function asAuditResult(audit: unknown): AuditResult | null {
  if (!audit || typeof audit !== "object") return null;
  const maybe = audit as Partial<AuditResult>;
  if (!Array.isArray(maybe.fixes)) return null;
  return audit as AuditResult;
}

/**
 * Map an aeo-audit OwningModule onto a roadmap ModuleRef. M5/M6/M8/M10/M14/M15
 * pass through; M13 (on-page auto-fix) is re-homed by the check that raised it.
 */
export function roadmapModuleForFix(fix: AuditFix): ModuleRef {
  if (fix.module !== "M13") return fix.module;
  const byCheck: Partial<Record<CheckId, ModuleRef>> = {
    ai_crawler_access: "M5",
    llms_txt: "M5",
    core_web_vitals: "M5",
    freshness: "M6",
    internal_linking: "M8",
    onpage_basics: "M8",
    entity_consistency: "M8",
  };
  return byCheck[fix.checkId] ?? "M5";
}

/** Which channel archetypes a roadmap module builds authority in (priority order). */
const MODULE_CHANNEL_ARCHETYPES: Record<ModuleRef, ChannelArchetype[]> = {
  M2: ["content"],
  M3: ["content"],
  M4: ["content"],
  M5: ["content"],
  M6: ["freshness", "content"],
  M8: ["content"],
  M10: ["content"],
  M11: ["social", "community"],
  M12: ["entity", "offsite", "podcast"],
  M14: ["local"],
  M15: ["reviews"],
};

/** Resolve the playbook channel a fix best builds authority in (always a real key). */
export function resolveChannelForModule(
  module: ModuleRef,
  playbook: Playbook,
): WeightedChannel | null {
  for (const archetype of MODULE_CHANNEL_ARCHETYPES[module]) {
    const match = topChannelOfArchetype(playbook, archetype);
    if (match) return match;
  }
  return topChannel(playbook);
}

/** True when local work is switched off for this playbook (national / disabled). */
function localOff(playbook: Playbook): boolean {
  return playbook.local_intensity === "national" || !playbook.local_module_config.enabled;
}

/**
 * Convert an AuditResult into gap-closing roadmap tasks. Local fixes (M14/M15)
 * are dropped when the local module is off, mirroring the tracker/audit gating.
 */
export function auditTasks(audit: AuditResult, playbook: Playbook): RoadmapTask[] {
  const tasks: RoadmapTask[] = [];
  for (const fix of audit.fixes) {
    const roadmapModule = roadmapModuleForFix(fix);
    if ((roadmapModule === "M14" || roadmapModule === "M15") && localOff(playbook))
      continue;

    const anchor = resolveChannelForModule(roadmapModule, playbook);
    if (!anchor) continue;

    const impact = fix.impact as ImpactLevel;
    const priorityScore = Math.round(
      anchor.weight * IMPACT_FACTOR[impact] * AUDIT_SOURCE_MULTIPLIER,
    );
    tasks.push({
      id: `audit/${fix.id}`,
      title: fix.title,
      description: fix.impactEstimate ? `${fix.detail} Impact: ${fix.impactEstimate}` : fix.detail,
      module: roadmapModule,
      channel: anchor.channel,
      source: "audit",
      impact,
      priorityScore,
      effortWeight: effortForImpact(impact),
      automationLevel: fix.automationLevel,
    });
  }
  return tasks;
}
